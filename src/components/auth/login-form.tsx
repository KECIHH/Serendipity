"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

export async function fetchAuthCsrf(): Promise<string> {
  const response = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Request could not be verified.");
  const data: unknown = await response.json();
  if (
    data === null ||
    typeof data !== "object" ||
    !("csrfToken" in data) ||
    typeof data.csrfToken !== "string"
  ) {
    throw new Error("Request could not be verified.");
  }
  return data.csrfToken;
}

export function LoginForm({ audience }: Readonly<{ audience: "ADMIN" | "USER" }>) {
  const router = useRouter();
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const csrfToken = await fetchAuthCsrf();
      const response = await fetch("/api/auth/callback/credentials", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body: new URLSearchParams({ email, password, audience, csrfToken }),
      });
      if (!response.ok) {
        setMessage(
          response.status === 401
            ? "邮箱或密码错误"
            : response.status === 429
              ? "登录尝试过于频繁，请稍后重试"
              : response.status === 400 || response.status === 403
                ? "请求验证失败，请重试"
                : "登录服务暂时不可用，请稍后重试",
        );
        return;
      }
      setPassword("");
      router.replace(audience === "ADMIN" ? "/admin" : "/");
      router.refresh();
    } catch {
      setMessage("登录服务暂时不可用，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "h-11 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

  return (
    <form
      onSubmit={submit}
      aria-label={audience === "ADMIN" ? "管理员登录" : "用户登录"}
      className="space-y-5"
    >
      <div className="space-y-2">
        <label htmlFor={`${id}-email`} className="block text-sm font-medium">
          邮箱
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={1_024}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          className={fieldClass}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-password`} className="block text-sm font-medium">
          密码
        </label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={72}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          className={fieldClass}
        />
      </div>
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" disabled={submitting}>
        {submitting ? "正在登录…" : "登录"}
      </Button>
    </form>
  );
}
