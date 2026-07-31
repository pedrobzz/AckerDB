use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

static PROCESS_BUDGET: Mutex<Weak<QueueBudgetScope>> = Mutex::new(Weak::new());

#[derive(Clone)]
pub struct QueueBudget {
    process: Arc<QueueBudgetScope>,
}

#[derive(Clone)]
pub struct GenerationQueueBudget {
    process: Arc<QueueBudgetScope>,
    generation: Arc<QueueBudgetScope>,
}

struct QueueBudgetScope {
    max_bytes: u32,
    permits: Arc<Semaphore>,
    reserved_bytes: AtomicU64,
    saturations: AtomicU64,
}

pub(crate) struct QueueReservation {
    _process: QueueScopeReservation,
    _generation: QueueScopeReservation,
}

pub(crate) struct QueueEntry<T> {
    item: T,
    reservation: QueueReservation,
}

impl<T> QueueEntry<T> {
    pub(crate) fn map<U>(self, convert: impl FnOnce(T) -> U) -> U {
        let Self { item, reservation } = self;
        let converted = convert(item);
        drop(reservation);
        converted
    }
}

struct QueueScopeReservation {
    _permit: OwnedSemaphorePermit,
    scope: Arc<QueueBudgetScope>,
    bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QueueSaturation {
    Process,
    Generation,
}

#[derive(Clone, Copy)]
enum QueueTerminal {
    Closed,
    ItemLimit,
    ProcessBudget,
    GenerationBudget,
}

struct QueueState<T> {
    items: VecDeque<(T, usize, QueueReservation)>,
    weight: usize,
    terminal: Option<QueueTerminal>,
}

pub struct BoundedQueue<T> {
    capacity: usize,
    max_weight: usize,
    budget: Mutex<Option<GenerationQueueBudget>>,
    state: Mutex<QueueState<T>>,
    changed: Notify,
    dropped: AtomicU64,
}

impl QueueBudget {
    pub fn new(max_bytes: u32) -> Result<Self, &'static str> {
        if max_bytes == 0 {
            return Err("maxQueuedBytes must be positive");
        }
        let mut process = PROCESS_BUDGET
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = process.upgrade() {
            if existing.max_bytes != max_bytes {
                return Err(
                    "maxQueuedBytes conflicts with the active native WebRTC process budget",
                );
            }
            return Ok(Self { process: existing });
        }
        let scope = QueueBudgetScope::new(max_bytes);
        *process = Arc::downgrade(&scope);
        Ok(Self { process: scope })
    }

    pub fn generation(&self, max_bytes: u32) -> Result<GenerationQueueBudget, &'static str> {
        if max_bytes == 0 {
            return Err("maxQueuedBytes must be positive");
        }
        Ok(GenerationQueueBudget {
            process: self.process.clone(),
            generation: QueueBudgetScope::new(max_bytes),
        })
    }

    /// Bytes currently admitted against the process queue-capacity budget.
    /// This includes active event/send payloads and conservative native-media
    /// queue capacity reservations; it is not an exact frame-queue depth.
    pub fn reserved_bytes(&self) -> u64 {
        self.process.reserved_bytes.load(Ordering::Relaxed)
    }

    pub fn saturations(&self) -> u64 {
        self.process.saturations.load(Ordering::Relaxed)
    }
}

impl GenerationQueueBudget {
    /// Bytes currently admitted against this generation's queue-capacity budget.
    pub fn reserved_bytes(&self) -> u64 {
        self.generation.reserved_bytes.load(Ordering::Relaxed)
    }

    pub fn saturations(&self) -> u64 {
        self.generation.saturations.load(Ordering::Relaxed)
    }

    pub(crate) fn reserve(&self, bytes: usize) -> Result<QueueReservation, QueueSaturation> {
        let bytes = match u32::try_from(bytes.max(1)) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.generation.saturations.fetch_add(1, Ordering::Relaxed);
                return Err(QueueSaturation::Generation);
            }
        };
        let process = self
            .process
            .reserve(bytes)
            .map_err(|()| QueueSaturation::Process)?;
        let generation = self
            .generation
            .reserve(bytes)
            .map_err(|()| QueueSaturation::Generation)?;
        Ok(QueueReservation {
            _process: process,
            _generation: generation,
        })
    }

    pub(crate) fn close(&self) {
        self.generation.permits.close();
    }
}

impl QueueBudgetScope {
    fn new(max_bytes: u32) -> Arc<Self> {
        Arc::new(Self {
            max_bytes,
            permits: Arc::new(Semaphore::new(max_bytes as usize)),
            reserved_bytes: AtomicU64::new(0),
            saturations: AtomicU64::new(0),
        })
    }

    fn reserve(self: &Arc<Self>, bytes: u32) -> Result<QueueScopeReservation, ()> {
        let permit = self
            .permits
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| {
                self.saturations.fetch_add(1, Ordering::Relaxed);
            })?;
        self.reserved_bytes
            .fetch_add(u64::from(bytes), Ordering::Relaxed);
        Ok(QueueScopeReservation {
            _permit: permit,
            scope: self.clone(),
            bytes,
        })
    }
}

impl Drop for QueueScopeReservation {
    fn drop(&mut self) {
        self.scope
            .reserved_bytes
            .fetch_sub(u64::from(self.bytes), Ordering::Relaxed);
    }
}

impl QueueSaturation {
    fn terminal(self) -> QueueTerminal {
        match self {
            Self::Process => QueueTerminal::ProcessBudget,
            Self::Generation => QueueTerminal::GenerationBudget,
        }
    }
}

impl QueueTerminal {
    fn name(self) -> Option<&'static str> {
        match self {
            Self::Closed => None,
            Self::ItemLimit => Some("queue-limit"),
            Self::ProcessBudget => Some("process-byte-budget"),
            Self::GenerationBudget => Some("generation-byte-budget"),
        }
    }

    fn error(self) -> &'static str {
        match self {
            Self::Closed => "",
            Self::ItemLimit => "native WebRTC queue exceeded its item or byte-weight limit",
            Self::ProcessBudget | Self::GenerationBudget => {
                "native WebRTC queue byte budget is saturated"
            }
        }
    }
}

impl<T> BoundedQueue<T> {
    pub fn new(capacity: usize, budget: GenerationQueueBudget) -> Self {
        Self::with_weight_limit(capacity, capacity, budget)
    }

    pub fn with_weight_limit(
        capacity: usize,
        max_weight: usize,
        budget: GenerationQueueBudget,
    ) -> Self {
        assert!(capacity > 0, "native queue capacity must be positive");
        assert!(max_weight > 0, "native queue weight limit must be positive");
        Self {
            capacity,
            max_weight,
            budget: Mutex::new(Some(budget)),
            state: Mutex::new(QueueState {
                items: VecDeque::new(),
                weight: 0,
                terminal: None,
            }),
            changed: Notify::new(),
            dropped: AtomicU64::new(0),
        }
    }

    pub fn push_weighted_with(
        &self,
        weight: usize,
        retained_bytes: usize,
        make_item: impl FnOnce() -> T,
    ) -> bool {
        let mut state = self.lock();
        if let Some(terminal) = state.terminal {
            if !matches!(terminal, QueueTerminal::Closed) {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return false;
        }
        if state.items.len() == self.capacity
            || weight > self.max_weight.saturating_sub(state.weight)
        {
            self.terminate(&mut state, QueueTerminal::ItemLimit);
            drop(state);
            self.release_budget();
            self.changed.notify_one();
            return false;
        }
        let reservation = match lock(&self.budget)
            .as_ref()
            .ok_or(QueueSaturation::Generation)
            .and_then(|budget| budget.reserve(retained_bytes))
        {
            Ok(reservation) => reservation,
            Err(saturation) => {
                self.terminate(&mut state, saturation.terminal());
                drop(state);
                self.release_budget();
                self.changed.notify_one();
                return false;
            }
        };
        state.items.push_back((make_item(), weight, reservation));
        state.weight += weight;
        drop(state);
        self.changed.notify_one();
        true
    }

    pub fn close(&self) {
        let mut state = self.lock();
        if state.terminal.is_none() {
            state.items.clear();
            state.weight = 0;
            state.terminal = Some(QueueTerminal::Closed);
        }
        drop(state);
        self.release_budget();
        self.changed.notify_one();
    }

    pub(crate) fn saturate(&self, saturation: QueueSaturation) {
        let mut state = self.lock();
        if state.terminal.is_some() {
            return;
        }
        self.terminate(&mut state, saturation.terminal());
        drop(state);
        self.release_budget();
        self.changed.notify_one();
    }

    pub(crate) fn saturate_item_limit(&self) {
        let mut state = self.lock();
        if state.terminal.is_some() {
            return;
        }
        self.terminate(&mut state, QueueTerminal::ItemLimit);
        drop(state);
        self.release_budget();
        self.changed.notify_one();
    }

    pub async fn next(&self) -> Result<Option<QueueEntry<T>>, String> {
        loop {
            // Create the waiter before inspecting state. Producers use
            // notify_one, which retains a permit if they win this race.
            let changed = self.changed.notified();
            {
                let mut state = self.lock();
                if let Some((item, weight, reservation)) = state.items.pop_front() {
                    state.weight -= weight;
                    return Ok(Some(QueueEntry { item, reservation }));
                }
                if let Some(terminal) = state.terminal {
                    return match terminal {
                        QueueTerminal::Closed => Ok(None),
                        _ => Err(terminal.error().to_owned()),
                    };
                }
            }
            changed.await;
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn terminal_reason(&self) -> Option<&'static str> {
        self.lock().terminal.and_then(QueueTerminal::name)
    }

    fn terminate(&self, state: &mut QueueState<T>, terminal: QueueTerminal) {
        self.dropped.fetch_add(
            state.items.len().saturating_add(1) as u64,
            Ordering::Relaxed,
        );
        state.items.clear();
        state.weight = 0;
        state.terminal = Some(terminal);
    }

    fn release_budget(&self) {
        lock(&self.budget).take();
    }

    fn lock(&self) -> MutexGuard<'_, QueueState<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
