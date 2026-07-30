use std::{
    collections::VecDeque,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::Notify;

struct QueueState<T> {
    items: VecDeque<(T, usize)>,
    weight: usize,
    terminal: Option<String>,
}

pub struct BoundedQueue<T> {
    capacity: usize,
    max_weight: usize,
    state: Mutex<QueueState<T>>,
    changed: Notify,
    dropped: AtomicU64,
}

impl<T> BoundedQueue<T> {
    pub fn new(capacity: usize) -> Self {
        Self::with_weight_limit(capacity, capacity)
    }

    pub fn with_weight_limit(capacity: usize, max_weight: usize) -> Self {
        assert!(capacity > 0, "native queue capacity must be positive");
        assert!(max_weight > 0, "native queue weight limit must be positive");
        Self {
            capacity,
            max_weight,
            state: Mutex::new(QueueState {
                items: VecDeque::with_capacity(capacity),
                weight: 0,
                terminal: None,
            }),
            changed: Notify::new(),
            dropped: AtomicU64::new(0),
        }
    }

    pub fn push(&self, item: T) -> bool {
        self.push_weighted(item, 1)
    }

    pub fn push_weighted(&self, item: T, weight: usize) -> bool {
        let mut state = self.lock();
        if let Some(reason) = &state.terminal {
            if !reason.is_empty() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return false;
        }
        if state.items.len() == self.capacity
            || weight > self.max_weight.saturating_sub(state.weight)
        {
            self.dropped.fetch_add(
                state.items.len().saturating_add(1) as u64,
                Ordering::Relaxed,
            );
            state.items.clear();
            state.weight = 0;
            state.terminal = Some(format!(
                "native WebRTC event queue exceeded its {} item / {} byte-weight limit",
                self.capacity, self.max_weight
            ));
            drop(state);
            self.changed.notify_one();
            return false;
        }
        state.items.push_back((item, weight));
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
            state.terminal = Some(String::new());
        }
        drop(state);
        self.changed.notify_one();
    }

    pub async fn next(&self) -> Result<Option<T>, String> {
        loop {
            // Create the waiter before inspecting state. Producers use
            // notify_one, which retains a permit if they win this race.
            let changed = self.changed.notified();
            {
                let mut state = self.lock();
                if let Some((item, weight)) = state.items.pop_front() {
                    state.weight -= weight;
                    return Ok(Some(item));
                }
                if let Some(reason) = &state.terminal {
                    return if reason.is_empty() {
                        Ok(None)
                    } else {
                        Err(reason.clone())
                    };
                }
            }
            changed.await;
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn lock(&self) -> MutexGuard<'_, QueueState<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
