/** The very large name + relationship card on the patient view. */
export default function NameCard({ name, relationship }: { name: string; relationship: string | null }) {
  return (
    <div className="rounded-3xl bg-white px-12 py-8 text-center text-black shadow-2xl">
      <div className="text-7xl font-bold leading-tight">{name}</div>
      {relationship && <div className="mt-2 text-5xl text-neutral-700">your {relationship}</div>}
    </div>
  );
}
