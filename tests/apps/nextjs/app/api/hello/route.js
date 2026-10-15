export function GET(request) {
  return Response.json({ hello: request.nextUrl.searchParams.get("name") ?? "world" });
}
export async function POST(request) {
  return Response.json({ received: await request.json() }, { status: 201 });
}
