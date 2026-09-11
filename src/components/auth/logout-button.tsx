"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { fetchAuthCsrf } from "@/components/auth/login-form";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [clearedLocally, setClearedLocally] = useState(false);

  async function logout() {
    if (submitting || clearedLocally) return;
    setSubmitting(true);
    setMessage("");
    try {
      const csrfToken = await fetchAuthCsrf();
      const response = await fetch("/api/auth/signout", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body: new URLSearchParams({ csrfToken, callbackUrl: "/admin/login" }),
      });
      if (response.status === 503) {
        if (response.headers.get("x-auth-session-cleared") === "1") {
          setClearedLocally(true);
          setMessage("本机登录已清除，服务端退出暂未完成。");
        } else {
          setMessage("暂时无法退出，请重试。");
        }
        return;
      }
      if (!response.ok) {
        setMessage("暂时无法退出，请重试。");
        return;
      }
      router.replace("/admin/login");
      router.refresh();
    } catch {
      setMessage("暂时无法退出，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        onClick={logout}
        disabled={submitting || clearedLocally}
      >
        {submitting ? "正在退出…" : "退出登录"}
      </Button>
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      {clearedLocally ? (
        <Link href="/admin/login" className="text-sm underline underline-offset-4">
          返回登录
        </Link>
      ) : null}
    </div>
  );
}
