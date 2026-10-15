export const dynamic = "force-dynamic";
export default async function Post({ params }) {
  const { id } = await params;
  return <article><h1>Post {id}</h1><p>{id} squared is {Number(id) ** 2}.</p></article>;
}
