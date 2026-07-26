import { AppState } from "react-native";
import type { AckerDBLifecycleSource } from "@ackerdb/client";

/**
 * The Expo lifecycle source: exactly one React Native `AppState` listener per
 * client lifetime, registered below hooks (the provider's effect constructs
 * the client; the client invokes this source at the end of construction) and
 * removed by close() before any other teardown.
 *
 * `background` retires the transport; `active` recovers it. The transient iOS
 * `inactive` state (notification center, permission dialogs, app switcher) is
 * observable but deliberately mapped to nothing — only a real background
 * transition retires the connection, so short system interruptions never
 * churn it. Platform emissions are forwarded verbatim: the client coalesces
 * duplicate suspend/resume notifications, so this observer stays stateless.
 */
export const appStateLifecycle: AckerDBLifecycleSource = (port) => {
  // A client constructed while the application is already backgrounded (for
  // example inside a brief background execution window) must not dial until
  // the application actually becomes active.
  if (AppState.currentState === "background") port.suspend();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") port.suspend();
    else if (state === "active") port.resume();
  });
  return () => subscription.remove();
};
