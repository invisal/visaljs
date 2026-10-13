export function GET(request) {
  const name = request.nextUrl.searchParams.get("name") ?? "world";
  return Response.json({ hello: name });
}

export async function POST(request) {
  return Response.json({ received: await request.json() }, { status: 201 });
}
