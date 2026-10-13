// node:os's networkInterfaces, getPriority and setPriority: shapes and errors (the machine's
// interfaces differ; the loopback's are fixed).
import os from "node:os";

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify(f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message + " " + JSON.stringify(e.info ?? null));
  }
};

const interfaces = os.networkInterfaces();
const loopback = Object.values(interfaces).flat().filter((a) => a.internal && (a.address === "127.0.0.1" || a.address === "::1"));
print("loopback: " + JSON.stringify(loopback));
print("every address: " + Object.values(interfaces).flat().every((a) =>
  typeof a.address === "string" && typeof a.netmask === "string" && (a.family === "IPv4" || a.family === "IPv6") &&
  /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(a.mac) && typeof a.internal === "boolean" && (a.cidr === null || a.cidr.startsWith(a.address + "/")) &&
  (a.family === "IPv6") === ("scopeid" in a)));
/* the priority this runs at depends on how it was started (nice): the three ways of asking agree */
const priority = os.getPriority();
print("priority: " + typeof priority + " " + (os.getPriority(0) === priority && os.getPriority(process.pid) === priority));
show("no such process", () => os.getPriority(999999999));
show("pid string", () => os.getPriority("x"));
show("too low", () => os.setPriority(-30));
show("raise (not root)", () => os.setPriority(0, -20));
os.setPriority(19);
print("lowered: " + os.getPriority());
print("constants: " + JSON.stringify(os.constants.priority));
