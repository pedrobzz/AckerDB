/**
 * The connect-screen placeholder. Studio always talks to its own origin — the
 * `acker studio` process proxies to the app server — so there is no URL field
 * here and never will be. The admin-credential semantics belong to #192, and
 * the real screen arrives with the UI-stack decision (#215).
 */
export function ConnectScreen() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "28rem",
        margin: "20vh auto 0",
        padding: "0 1rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem" }}>AckerDB Studio</h1>
      <p style={{ color: "#555" }}>
        Connected to this origin&apos;s app server. Sign in with the Studio
        admin credential to continue.
      </p>
      <form onSubmit={(event) => event.preventDefault()}>
        <input
          type="password"
          name="credential"
          placeholder="Admin credential (coming soon)"
          disabled
          style={{ width: "100%", padding: "0.5rem", boxSizing: "border-box" }}
        />
      </form>
    </main>
  );
}
