import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Hello, Next.js!</h1>
      <ul>
        <li><Link href="/posts/1">Post 1</Link></li>
        <li><Link href="/posts/2">Post 2</Link></li>
        <li><a href="/api/hello?name=visaljs">/api/hello</a></li>
      </ul>
    </main>
  );
}
