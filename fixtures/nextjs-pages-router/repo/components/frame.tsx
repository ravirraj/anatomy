export default function Frame({ title, children }: { title: string; children: unknown }) {
  return (
    <article>
      <h1>{title}</h1>
      <main>{children}</main>
    </article>
  );
}
