import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="px-4 py-8 sm:px-6 lg:px-8">
      <section className="mx-auto w-full rounded-card bg-brand-500 p-gutter shadow-card wide:max-w-5xl">
        <h1 className="text-2xl font-semibold text-primary-foreground">Serendipity · 际遇</h1>
        <Button variant="outline" className="mt-6 min-h-11">
          开始规划
        </Button>
      </section>
    </main>
  );
}
