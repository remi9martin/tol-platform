"use client";

// Login runs CLIENT-SIDE (browser fetch, not a Next.js Server Action) —
// apps/api and apps/web are different origins in local dev, and a
// direct browser->API fetch lets the browser store the Set-Cookie
// response headers natively. Routing this through a Server Action would
// mean the NEXT.JS SERVER receives those Set-Cookie headers first and
// has to manually re-forward them to the browser with matching
// attributes — solvable, but a real source of subtle cookie-attribute
// bugs for no benefit here, since apps/api's CORS (this stage) already
// allows credentialed cross-origin requests from this exact origin.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api-client";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.login({ email, password });
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : "Sign-in failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="mono-label mb-3">
        <span className="text-red">TOL</span> — Trust Online
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-ink">Sign in</h1>

      <form onSubmit={handleSubmit} className="panel flex flex-col gap-4 p-5" noValidate>
        <div>
          <label htmlFor="email" className="mono-label mb-1.5 block">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field-input"
            placeholder="you@organization.example"
          />
        </div>
        <div>
          <label htmlFor="password" className="mono-label mb-1.5 block">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field-input"
          />
        </div>

        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn btn-go justify-center">
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mono-label mt-6">earlier seeded users only — see packages/db/README.md.</p>
    </main>
  );
}
