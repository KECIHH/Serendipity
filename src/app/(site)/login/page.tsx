import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="mx-auto max-w-sm space-y-7 py-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">登录际遇</h1>
        <p className="text-muted-foreground">欢迎回来。</p>
      </div>
      <LoginForm audience="USER" />
    </main>
  );
}
