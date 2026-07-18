import { useChat } from "@ai-sdk/react";
import { useChatTransport } from "@dbzz/client-react/ai";
import { api } from "@demo/dbzz-codegen/api";
import { useMemo, useState, type ReactNode } from "react";
import { activeToolStatus } from "./chat-format.tsx";
import { ChatLauncher } from "./chat-fab.tsx";
import { defaultGeometry, type Geometry } from "./chat-geometry.ts";
import { ChatWindow } from "./chat-window.tsx";

type ChatMode = "closed" | "open" | "minimized";

/**
 * Owns the single admin-session chat: one `useChat` bound to the dbzz chat
 * transport, plus the floating window's mode and geometry. Mounted inside the
 * `_admin` layout, it stays alive across page navigation, so the conversation
 * and window placement persist until a reload (nothing is stored). It renders
 * the page beneath it and the launcher/window overlays above it.
 */
export function AdminChatProvider({ children }: Readonly<{ children: ReactNode }>) {
  const transport = useChatTransport(api.chat.stream);
  const chat = useChat({ transport });
  const [mode, setMode] = useState<ChatMode>("closed");
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  const streaming = chat.status === "submitted" || chat.status === "streaming";
  const active = useMemo(() => activeToolStatus(chat.messages), [chat.messages]);

  function open() {
    setGeometry((current) => current ?? defaultGeometry());
    setMode("open");
  }

  return (
    <>
      {children}
      <ChatLauncher
        mode={mode}
        streaming={streaming}
        active={active}
        hasActivity={chat.messages.length > 0}
        onOpen={open}
        onClose={() => setMode("closed")}
      />
      {mode === "open" && geometry !== null && (
        <ChatWindow
          chat={chat}
          geometry={geometry}
          onGeometryChange={(updater) => setGeometry((current) => (current ? updater(current) : current))}
          onMinimize={() => setMode("minimized")}
          onClose={() => setMode("closed")}
        />
      )}
    </>
  );
}
