// The shell: the access gate, the hash route, and the header. Every screen below it
// assumes the session is already good.

import { useEffect, useState } from "react";
import { ApiError, api, reason, setOnUnauthorized } from "./api.ts";
import { LibraryScreen } from "./library.tsx";
import { PlayerScreen } from "./player.tsx";
import { SettingsScreen } from "./settings.tsx";

/** The current hash route, re-read on every back/forward and every link click. */
function useHash(): string {
  const [hash, setHash] = useState(() => location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const [gate, setGate] = useState<"checking" | "locked" | "open">("checking");
  const hash = useHash();

  useEffect(() => {
    setOnUnauthorized(() => setGate("locked"));
    api.session().then(
      () => setGate("open"),
      () => setGate("locked"),
    );
  }, []);

  if (gate === "checking") return <p className="notice">…</p>;
  if (gate === "locked") return <Gate onOpen={() => setGate("open")} />;

  const resourceId = hash.startsWith("#/r/") ? decodeURIComponent(hash.slice(4)) : null;
  return (
    <>
      <header>
        <a href="#/" className="brand">
          duolistening
        </a>
        <a href="#/settings">Settings</a>
      </header>
      {resourceId ? (
        <PlayerScreen id={resourceId} />
      ) : hash === "#/settings" ? (
        <SettingsScreen />
      ) : (
        <LibraryScreen />
      )}
    </>
  );
}

/**
 * The single shared password (ADR 0001). A successful POST sets the session cookie,
 * so nothing is kept here — reloading the page stays logged in, and so does the
 * <audio> element, which cannot send a header of its own.
 */
function Gate({ onOpen }: { onOpen: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="gate"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await api.login(password);
          onOpen();
        } catch (failure) {
          setError(failure instanceof ApiError ? "Wrong password" : reason(failure));
        }
      }}
    >
      <h1>duolistening</h1>
      <input
        type="password"
        autoFocus
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button type="submit">Enter</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
