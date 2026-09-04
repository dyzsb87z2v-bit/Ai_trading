/**
 * Shown when the app has no AUTH_SECRET / APP_PASSWORD. It refuses to run
 * rather than falling back to a default credential.
 */
export default function SetupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface p-5">
        <h1 className="text-base font-semibold">Setup required</h1>
        <p className="mt-2 text-xs text-muted">
          This app will not issue a session until it has its own secret and password. It never falls
          back to a built-in default.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md bg-surface-2 p-3 text-[11px] leading-relaxed">
          {`cp .env.example .env

# then set both values in .env:
AUTH_SECRET=$(openssl rand -base64 48)
APP_PASSWORD=<choose a password>`}
        </pre>
        <p className="mt-3 text-[11px] text-muted">Restart the server after editing .env.</p>
      </div>
    </main>
  );
}
