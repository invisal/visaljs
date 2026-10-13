export const dynamic = "force-dynamic";

/* rendered on each request: the server runs React on the compiled binary */
export default async function Post({ params }) {
  const { id } = await params;
  return (
    <article>
      <h1>Post {id}</h1>
      <p>Rendered at request time; {id} squared is {Number(id) ** 2}.</p>
    </article>
  );
}
