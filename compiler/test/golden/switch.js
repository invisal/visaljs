function describe(x) {
  let out = "";
  switch (x) {
    case 1:
      out += "one ";
    case 2:
      out += "two-or-fallthrough ";
      break;
    default:
      out += "other ";
    case 3:
      out += "three ";
  }
  return out;
}
print(describe(1), describe(3), describe(9));
