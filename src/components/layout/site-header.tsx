import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-border-subtle bg-surface text-foreground">
      <div className="mx-auto flex w-full min-w-0 flex-col gap-4 p-gutter sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8 wide:max-w-5xl">
        <Link
          href="/"
          className="inline-flex min-h-11 min-w-0 items-center self-start text-lg font-semibold no-underline"
        >
          Serendipity · 际遇
        </Link>
        <nav aria-label="主导航">
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <li>旅行规划</li>
            <li>历史计划</li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
