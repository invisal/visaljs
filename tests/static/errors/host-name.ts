// error: typed unit: export 'fsExists' is a host primitive's name
"use static";

export function fsExists(): number {
  return 0;
}
