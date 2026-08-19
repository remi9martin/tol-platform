import Link from "next/link";

export default function PublicHomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="mono-label mb-4">
        <span className="text-red">TOL</span> — Trust Online · Working name, see ADR-0003
      </div>
      <h1 className="mb-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
        Visible market. <span className="text-coral">Private deal.</span>
      </h1>
      <p className="mb-8 max-w-xl text-[15px] leading-relaxed text-ink-2">
        An institutional marketplace for merchant-acquiring capacity. Organizations sign in,
        maintain a private profile, and are matched under role-based, tenant-isolated access
        control — every restricted action is audited.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/sign-in" className="btn btn-go">
          Sign in
        </Link>
      </div>
      <div className="mt-16 border-t border-edge pt-6">
        <p className="mono-label">earlier build — auth, orgs, roles, tenant isolation, audit base.</p>
      </div>
    </main>
  );
}
