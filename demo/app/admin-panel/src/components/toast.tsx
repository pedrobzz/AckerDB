import { AlertCircle, BellRing, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastTone = "success" | "warning" | "error" | "info";

interface ToastMessage {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title?: string;
  readonly message: string;
}

interface ToastApi {
  success(message: string, title?: string): void;
  warning(message: string, title?: string): void;
  error(message: string, title?: string): void;
  info(message: string, title?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextToastId = 1;

export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, title?: string) => {
      const id = nextToastId++;
      setMessages((current) => [
        ...current.slice(-3),
        { id, tone, message, title },
      ]);
      timers.current.set(
        id,
        setTimeout(() => remove(id), tone === "warning" ? 8_000 : 5_000),
      );
    },
    [remove],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo<ToastApi>(
    () => ({
      success: (message, title) => push("success", message, title),
      warning: (message, title) => push("warning", message, title),
      error: (message, title) => push("error", message, title),
      info: (message, title) => push("info", message, title),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="toast-region"
        aria-live="polite"
        aria-label="Notifications"
      >
        {messages.map((message) => (
          <Toast
            key={message.id}
            message={message}
            onDismiss={() => remove(message.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("useToast requires a ToastProvider");
  return value;
}

function Toast({
  message,
  onDismiss,
}: Readonly<{ message: ToastMessage; onDismiss: () => void }>) {
  const Icon =
    message.tone === "success"
      ? CheckCircle2
      : message.tone === "warning"
        ? BellRing
        : message.tone === "error"
          ? AlertCircle
          : Info;
  return (
    <article className={`toast toast--${message.tone}`} role="status">
      <span className="toast__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="toast__copy">
        {message.title && <strong>{message.title}</strong>}
        <p>{message.message}</p>
      </div>
      <button
        className="icon-button icon-button--quiet"
        type="button"
        onClick={onDismiss}
      >
        <span className="sr-only">Dismiss notification</span>
        <X aria-hidden="true" />
      </button>
    </article>
  );
}
