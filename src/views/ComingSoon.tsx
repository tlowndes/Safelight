export default function ComingSoon({ title, phase, text }: { title: string; phase: string; text: string }) {
  return (
    <div className="empty">
      <div className="eyebrow">{phase}</div>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
