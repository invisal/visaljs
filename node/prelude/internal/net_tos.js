// net.Socket's type of service, as Node's: setTypeOfService, getTypeOfService and the
// typeOfService option (IP_TOS, or IPV6_TCLASS on an IPv6 socket; on Windows, best effort). Linked
// into programs that name it (internal/features.js).
import { errnoName, netTypeOfService } from "visaljs:host";
import { invalidArgType } from "./errors.js";
import { features } from "./features.js";
import { validateInt32 } from "./streams/validators.js";

const isWindows = process.platform === "win32";
const UV_EBADF = -9;

/* Node's handle exists from connect() on, its descriptor only once connect(2) is under way:
 * between the two, the option can't be set or read */
const noDescriptor = (socket) => socket._handle === null && socket.connecting;

features.validateTypeOfService = (tos) => validateInt32(tos, "options.typeOfService", 0, 255);

/* kept until there's a handle */
features.setTypeOfService = function (tos) {
  if (Number.isNaN(tos)) throw invalidArgType("tos", "of type number", tos);
  validateInt32(tos, "tos", 0, 255);
  if (noDescriptor(this) && !this._isPipe && tos !== this._tos) {
    this._tos = tos;
    if (!isWindows) throw features.net.errnoException(UV_EBADF, "setTypeOfService");
    return this;
  }
  if (this._handle === null || this._isPipe) {
    this._tos = tos;
    return this;
  }
  if (tos !== this._tos) {
    this._tos = tos;
    const err = netTypeOfService(this._handle, tos);
    if (err && !isWindows) throw features.net.errnoException(err, "setTypeOfService");
  }
  return this;
};

features.getTypeOfService = function () {
  if (noDescriptor(this) && !this._isPipe && !isWindows) throw features.net.errnoException(UV_EBADF, "getTypeOfService");
  if (this._handle === null || this._isPipe) return this._tos !== undefined ? this._tos : 0;
  const res = netTypeOfService(this._handle, -1);
  if (res < 0) {
    if (isWindows) return this._tos !== undefined ? this._tos : 0;
    throw features.net.errnoException(res, "getTypeOfService");
  }
  return res;
};

/* the type of service given before the connection, set once it's made */
features.applyTypeOfService = (socket) => {
  const err = netTypeOfService(socket._handle, socket._tos);
  if (err && errnoName(err) !== "EBADF" && !isWindows) socket.emit("error", features.net.errnoException(err, "setTypeOfService"));
};
