import { fileExt, Item, thumbUrl } from "../api";

export default function Thumb({ item, onClick, children, className = "" }: { item: Item; onClick?: (e: React.MouseEvent) => void; children?: React.ReactNode; className?: string }) {
  const url = thumbUrl(item);
  return (
    <div className={`ph ${className} ${onClick ? "clickable" : ""}`} onClick={onClick} title={item.path}>
      {url ? <img src={url} loading="lazy" alt="" /> : <span className="fmt">{fileExt(item.path)}</span>}
      {item.kind === "video" && <span className="vid">▶</span>}
      {children}
    </div>
  );
}
