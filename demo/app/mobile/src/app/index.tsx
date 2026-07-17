import { Redirect } from "expo-router";
import { useSession } from "../providers/session";

export default function IndexRoute() {
  const { session } = useSession();
  return <Redirect href={session === null ? "/login" : "/(tabs)/tables"} />;
}
