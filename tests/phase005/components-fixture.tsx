import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { PageHeader } from "@/components/common/page-header";
import { AdminShell } from "@/components/layout/admin-shell";
import { SiteHeader } from "@/components/layout/site-header";
import { Button } from "@/components/ui/button";

export function ComponentsFixture() {
  return (
    <>
      <SiteHeader />
      <AdminShell>
        <div className="space-y-6">
          <PageHeader
            title="公共组件"
            actions={
              <Button type="button" variant="outline" className="min-h-11 border-input">
                页面操作
              </Button>
            }
          />
          <section aria-label="加载状态">
            <LoadingState label="正在加载内容…" />
          </section>
          <section aria-label="空状态">
            <EmptyState
              title="暂无内容"
              description="当前没有可展示的内容。"
              action={
                <Button type="button" variant="outline" className="min-h-11 border-input">
                  查看说明
                </Button>
              }
            />
          </section>
          <section aria-label="错误状态">
            <ErrorState message="加载失败，请稍后重试。" onRetry={() => {}} />
          </section>
          <section aria-label="只读错误状态">
            <ErrorState message="内容不可用" />
          </section>
        </div>
      </AdminShell>
    </>
  );
}

export default <ComponentsFixture />;
