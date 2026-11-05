import { fileExt, Item, thumbUrl } from "../api";

type Props = { item: Item; onClick?: (e: React.MouseEvent) => void; onContextMenu?: (e: React.MouseEvent) => void; children?: React.ReactNode; className?: string };

export default function Thumb({ item, onClick, onContextMenu, children, className = "" }: Props) {
  const url = thumbUrl(item);
  return (
    <div className={`ph ${className} ${onClick ? "clickable" : ""}`} onClick={onClick} onContextMenu={onContextMenu} title={item.path} data-id={item.id}>
      {url ? <img src={url} loading="lazy" alt="" /> : <span className="fmt">{fileExt(item.path)}</span>}
      {item.kind === "video" && <span className="vid">▶</span>}
      {children}
    </div>
  );
}
