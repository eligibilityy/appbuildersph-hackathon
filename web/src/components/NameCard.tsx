/** The very large name + relationship card on the patient view. (Position is set by the parent.) */
export default function NameCard({ name, relationship }: { name: string; relationship: string | null }) {
  return (
    <div className="rounded-[28px] border border-black/5 bg-card px-12 py-7 text-center text-card-foreground">
      <div className="text-[64px] leading-[1.1] font-bold tracking-[-0.02em]">{name}</div>
      {relationship && <div className="mt-1 text-[36px] leading-tight text-muted-foreground">your {relationship}</div>}
    </div>
  );
}
