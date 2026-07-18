import { useConnectionState, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import {
  ChefHat,
  ClipboardList,
  Grid2X2,
  Menu as MenuIcon,
  ReceiptText,
  Sparkles,
  TableProperties,
  Utensils,
  Users,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { AdminChatProvider } from "../components/chat/chat-provider.tsx";
import { useFocusBoundary } from "../components/ui.tsx";

export const Route = createFileRoute("/_admin")({
  component: AdminLayout,
  ssr: false,
});

interface NavigationItem {
  readonly label: string;
  readonly to: "/" | "/orders" | "/kitchen" | "/menu" | "/tables" | "/guests" | "/agents";
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
  { label: "Agents", to: "/agents", icon: Sparkles },
];

const navLinkClasses =
  "flex min-h-11 items-center gap-[11px] rounded-[11px] px-[13px] text-[13px] font-[550] text-[#b5c7c0] transition-colors duration-150 " +
  "[&_svg]:size-[17px] [&_svg]:text-[#91a89f] " +
  "hover:bg-white/[0.07] hover:text-warm-white " +
  "data-[status=active]:bg-warm-white data-[status=active]:font-[750] data-[status=active]:text-forest-950 " +
  "data-[status=active]:[&_svg]:text-forest-950 " +
  "data-[status=active]:hover:bg-warm-white data-[status=active]:hover:text-forest-950";

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
    <AdminChatProvider>
      <div className="flex min-h-screen bg-cream-50">
      <button
        className="hidden max-[900px]:fixed max-[900px]:left-[14px] max-[900px]:top-[14px] max-[900px]:z-[24] max-[900px]:inline-flex max-[900px]:size-[42px] max-[900px]:items-center max-[900px]:justify-center max-[900px]:rounded-xl max-[900px]:bg-forest-900 max-[900px]:text-white max-[900px]:shadow-[0_18px_60px_rgb(29_41_37/0.08)] print:!hidden"
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
          className="hidden max-[900px]:fixed max-[900px]:inset-0 max-[900px]:z-[29] max-[900px]:block max-[900px]:border-0 max-[900px]:bg-[rgb(16_42_36/0.48)]"
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-30 flex w-[238px] flex-col overflow-y-auto bg-forest-950 px-[18px] pb-[22px] pt-[27px] text-warm-white print:!hidden",
          "max-[900px]:transition-transform max-[900px]:duration-200",
          open
            ? "max-[900px]:visible max-[900px]:translate-x-0"
            : "max-[900px]:invisible max-[900px]:-translate-x-[105%]",
        ].join(" ")}
        id="admin-sidebar"
        ref={sidebar}
      >
        <div className="flex items-start justify-between px-2 pb-[30px]">
          <div className="flex items-center gap-[11px]">
            <span
              className="inline-flex size-10 items-center justify-center rounded-full bg-warm-white text-forest-900 [&_svg]:size-5"
              aria-hidden="true"
            >
              <ChefHat />
            </span>
            <div>
              <strong className="block font-display text-[27px] font-semibold leading-none tracking-[-0.035em]">
                Savoria
              </strong>
              <span className="mt-[7px] block text-[8px] font-[750] uppercase tracking-[0.15em] text-[#9eb7ad]">
                Restaurant OS
              </span>
            </div>
          </div>
          <button
            className="hidden size-9 flex-none items-center justify-center rounded-[11px] border border-white/20 bg-transparent text-warm-white max-[900px]:inline-flex [&_svg]:size-3.5"
            type="button"
            onClick={() => setOpen(false)}
          >
            <span className="sr-only">Close navigation</span>
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="flex flex-col gap-[5px]" aria-label="Restaurant admin">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={navLinkClasses}
                activeOptions={{ exact: item.to === "/" }}
                onClick={() => setOpen(false)}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.kitchen && attentionCount > 0 && (
                  <b
                    className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-clay-500 px-1.5 text-[9px] text-white"
                    aria-label={`${attentionCount} active kitchen items`}
                  >
                    {attentionCount}
                  </b>
                )}
              </Link>
            );
          })}
        </nav>

        <div
          className="mt-auto flex items-center gap-2 px-[11px] pb-3 pt-[18px] text-[10px] capitalize text-[#9eb7ad] [&_svg]:text-[#83b296]"
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

        <div className="flex items-center gap-2.5 border-t border-[#2a4b43] px-[11px] pb-1 pt-4">
          <span
            className="inline-flex size-[34px] flex-none items-center justify-center rounded-full bg-clay-500 text-[11px] font-extrabold"
            aria-hidden="true"
          >
            AM
          </span>
          <div className="min-w-0">
            <strong className="block text-[11px]">Amelia Morgan</strong>
            <small className="mt-[3px] block text-[9px] text-[#91a89f]">
              General manager
            </small>
          </div>
        </div>
      </aside>

      <main className="ml-[238px] w-[calc(100%-238px)] min-w-0 max-[900px]:ml-0 max-[900px]:w-full print:!m-0 print:!w-full">
        <Outlet />
      </main>
      </div>
    </AdminChatProvider>
  );
}
