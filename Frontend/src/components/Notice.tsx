import type { ReactNode } from "react";

export type NoticeTone = "info" | "warn" | "danger";

export default function Notice({
  tone = "info",
  title,
  children,
  actions
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === "danger" ? "alert" : "status"} aria-live={tone === "danger" ? "assertive" : "polite"}>
      <div className="noticeTop">
        <div className="noticeTitle">{title}</div>
        {actions ? <div className="noticeActions">{actions}</div> : null}
      </div>
      {children ? <div className="noticeBody">{children}</div> : null}
    </div>
  );
}

