import Link from "next/link";
import Counter from "./counter";
export default function Home() {
  return (
    <main>
      <h1>Hello, Next.js!</h1>
      <Counter />
      <ul>
        <li><Link href="/posts/1">Post 1</Link></li>
        <li><a href="/api/hello?name=visaljs">/api/hello</a></li>
      </ul>
    </main>
  );
}
