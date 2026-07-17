import { useConnectionState, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import {
  ChefHat,
  ClipboardList,
  Grid2X2,
  Menu as MenuIcon,
  ReceiptText,
  TableProperties,
  Utensils,
  Users,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useFocusBoundary } from "../components/ui.tsx";

export const Route = createFileRoute("/_admin")({
  component: AdminLayout,
  ssr: false,
});

interface NavigationItem {
  readonly label: string;
  readonly to: "/" | "/orders" | "/kitchen" | "/menu" | "/tables" | "/guests";
  readonly icon: LucideIcon;
  readonly kitchen?: boolean;
}

const navigation: readonly NavigationItem[] = [
  { label: "Overview", to: "/", icon: Grid2X2 },
  { label: "Orders", to: "/orders", icon: ReceiptText },
  {
    label: "Kitchen queue",
    to: "/kitchen",
    icon: ClipboardList,
    kitchen: true,
  },
  { label: "Menu", to: "/menu", icon: Utensils },
  { label: "Tables", to: "/tables", icon: TableProperties },
  { label: "Guests", to: "/guests", icon: Users },
];

function AdminLayout() {
  const [open, setOpen] = useState(false);
  const sidebar = useFocusBoundary<HTMLElement>(open, () => setOpen(false));
  const connection = useConnectionState();
  const kitchen = useQuery(api.kitchen.queue, {});
  const attentionCount =
    kitchen.status === "success"
      ? kitchen.data.filter(
          (item) => item.status !== "SERVED" && item.status !== "CANCELLED",
        ).length
      : 0;
  const connected = connection.phase === "ready";

  return (
    <div className="admin-layout">
      <button
        className="mobile-menu-button"
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="admin-sidebar"
      >
        <MenuIcon aria-hidden="true" />
        <span className="sr-only">Open navigation</span>
      </button>

      {open && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={`sidebar${open ? " sidebar--open" : ""}`}
        id="admin-sidebar"
        ref={sidebar}
      >
        <div className="sidebar__top">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <ChefHat />
            </span>
            <div>
              <strong>Savoria</strong>
              <span>Restaurant OS</span>
            </div>
          </div>
          <button
            className="sidebar__close icon-button icon-button--inverse"
            type="button"
            onClick={() => setOpen(false)}
          >
            <span className="sr-only">Close navigation</span>
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="Restaurant admin">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="nav-link"
                activeProps={{ className: "nav-link nav-link--active" }}
                activeOptions={{ exact: item.to === "/" }}
                onClick={() => setOpen(false)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.kitchen && attentionCount > 0 && (
                  <b aria-label={`${attentionCount} active kitchen items`}>
                    {attentionCount}
                  </b>
                )}
              </Link>
            );
          })}
        </nav>

        <div
          className="sidebar__connection"
          title={`Connection: ${connection.phase}`}
        >
          {connected ? (
            <Wifi aria-hidden="true" />
          ) : (
            <WifiOff aria-hidden="true" />
          )}
          <span>
            {connected ? "Live floor" : connection.phase.replaceAll("-", " ")}
          </span>
        </div>

        <div className="staff-profile">
          <span aria-hidden="true">AM</span>
          <div>
            <strong>Amelia Morgan</strong>
            <small>General manager</small>
          </div>
        </div>
      </aside>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
