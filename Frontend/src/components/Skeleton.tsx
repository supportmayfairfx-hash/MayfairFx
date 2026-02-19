export default function Skeleton({ className = "", style }: { className?: string; style?: any }) {
  return <div className={`skel ${className}`.trim()} style={style} aria-hidden="true" />;
}

