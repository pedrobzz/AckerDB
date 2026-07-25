import type { DbzzQueryState } from "@dbzz/client-react";
import type { ApplicationError } from "@dbzz/core";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash2,
  LoaderCircle,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { statusLabel } from "../lib/domain.ts";

export function PageHeader({
  title,
  subtitle,
  action,
}: Readonly<{ title: string; subtitle: string; action?: ReactNode }>) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action && <div className="page-header__actions">{action}</div>}
    </header>
  );
}

export function StatusPill({ status }: Readonly<{ status: string }>) {
  return (
    <span className={`status-pill status-pill--${status.toLowerCase()}`}>
      <span aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}>) {
  return (
    <label className="search-field">
      <span className="sr-only">{label}</span>
      <Search aria-hidden="true" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button type="button" onClick={() => onChange("")}>
          <span className="sr-only">Clear search</span>
          <X aria-hidden="true" />
        </button>
      )}
    </label>
  );
}

export function QueryContent<
  Data,
  Error extends ApplicationError = never,
>({
  state,
  children,
  loadingLabel = "Loading live data…",
}: Readonly<{
  state: DbzzQueryState<Data, Error>;
  children: (data: Data) => ReactNode;
  loadingLabel?: string;
}>) {
  if (state.status === "pending" || state.status === "disabled") {
    return <StatePanel icon={LoaderCircle} title={loadingLabel} spinning />;
  }
  if (state.status === "application-error") {
    return (
      <StatePanel
        icon={AlertTriangle}
        title="Request could not be completed"
        detail={`Application error: ${state.error.code}`}
        tone="danger"
      />
    );
  }
  if (state.status === "rejected" || state.status === "unavailable") {
    if (state.status === "unavailable" && state.data !== undefined) {
      return <>{children(state.data)}</>;
    }
    const unauthorized =
      state.error.code === "unauthenticated" ||
      state.error.code === "unauthorized";
    return (
      <StatePanel
        icon={AlertTriangle}
        title={
          unauthorized
            ? "Staff authorization required"
            : "Live data unavailable"
        }
        detail={state.error.message}
        tone="danger"
      />
    );
  }
  return <>{children(state.data)}</>;
}

export function StatePanel({
  icon: Icon = CircleSlash2,
  title,
  detail,
  tone = "quiet",
  spinning = false,
  action,
}: Readonly<{
  icon?: LucideIcon;
  title: string;
  detail?: string;
  tone?: "quiet" | "danger" | "success";
  spinning?: boolean;
  action?: ReactNode;
}>) {
  return (
    <div
      className={`inline-state inline-state--${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon className={spinning ? "spin" : undefined} aria-hidden="true" />
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

export function SuccessState({
  title,
  detail,
}: Readonly<{ title: string; detail?: string }>) {
  return (
    <StatePanel
      icon={CheckCircle2}
      title={title}
      detail={detail}
      tone="success"
    />
  );
}

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusBoundary<Element extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
) {
  const boundary = useRef<Element>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active || boundary.current === null) return;

    const element = boundary.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.querySelector<HTMLElement>(focusableSelector)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        element.querySelectorAll<HTMLElement>(focusableSelector),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [active]);

  return boundary;
}

export function Modal({
  title,
  description,
  children,
  onClose,
  size = "medium",
}: Readonly<{
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: "small" | "medium" | "large";
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useFocusBoundary<HTMLDivElement>(true, onClose);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={panel}
      >
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            className="icon-button icon-button--quiet"
            type="button"
            onClick={onClose}
          >
            <span className="sr-only">Close dialog</span>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: Readonly<{
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}>) {
  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      size="small"
    >
      <div className="dialog-actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={onClose}
          disabled={busy}
        >
          Keep it
        </button>
        <button
          className="button button--danger"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function FormShell({
  onSubmit,
  children,
  submitLabel,
  busy,
  error,
  onCancel,
}: Readonly<{
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
}>) {
  return (
    <form className="form-stack" onSubmit={onSubmit}>
      {children}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="button button--primary"
          type="submit"
          disabled={busy}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function Field({
  label,
  hint,
  children,
}: Readonly<{ label: string; hint?: string; children: ReactNode }>) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
