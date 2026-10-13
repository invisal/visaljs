// util.parseArgs: Node's internal/util/parse_args (from pkgjs/parseargs, MIT): command-line
// arguments against declared options (string or boolean, short aliases, multiple, defaults),
// strict about unknown options and positionals, with tokens on request. Linked into programs
// that name parseArgs (internal/features.js).
// Ported from Node.js and pkgjs/parseargs (MIT): node/third_party/nodejs/LICENSE and
// node/third_party/parseargs/LICENSE.
import { codeError, invalidArgType, invalidArgValue } from "./errors.js";
import { features } from "./features.js";

const isOptionValue = (value) => value != null;  /* a value an option may take: anything not nullish */

/* `--foo=bar` and `-f` style */
const isLoneShortOption = (arg) => arg.length === 2 && arg[0] === "-" && arg[1] !== "-";
const isLoneLongOption = (arg) => arg.length > 2 && arg.startsWith("--") && !arg.includes("=", 3);
const isLongOptionAndValue = (arg) => arg.length > 2 && arg.startsWith("--") && arg.includes("=", 3);
const isShortOptionGroup = (arg, options) => {
  if (arg.length <= 2 || arg[0] !== "-" || arg[1] === "-") return false;
  const firstShort = arg[1];
  const longOption = findLongOptionForShort(firstShort, options);
  return options[longOption]?.type !== "string";
};
const isShortOptionAndValue = (arg, options) => {
  if (arg.length <= 2 || arg[0] !== "-" || arg[1] === "-") return false;
  const shortOption = arg[1];
  const longOption = findLongOptionForShort(shortOption, options);
  return options[longOption]?.type === "string";
};
/* the next argument may be an option's value: it isn't an option itself */
const isOptionLikeValue = (value) => value != null && value.length > 1 && value[0] === "-";

function findLongOptionForShort(shortOption, options) {
  for (const [longOption, config] of Object.entries(options)) {
    if (config.short === shortOption) return longOption;
  }
  return shortOption;
}

/** Whether a known option should be stored as an array. */
function useDefaultValueOption(longOption, optionConfig, values) {
  return optionConfig.default !== undefined && values[longOption] === undefined;
}

function validateString(value, name) {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
}
function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}
function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "of type object", value);
}
function validateArray(value, name) {
  if (!Array.isArray(value)) throw invalidArgType(name, "an instance of Array", value);
}
function validateStringArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) validateString(value[i], `${name}[${i}]`);
}
function validateBooleanArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) validateBoolean(value[i], `${name}[${i}]`);
}
function validateUnion(value, name, union) {
  if (!union.includes(value)) throw invalidArgType(name, `('${union.join("|")}')`, value);
}

const parseArgsUnknownOption = (option, allowPositionals) => {
  const suggestDashDash = allowPositionals ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(option)}` : "";
  return codeError(TypeError, "ERR_PARSE_ARGS_UNKNOWN_OPTION", `Unknown option '${option}'${suggestDashDash}`);
};

function checkOptionLikeValue(token) {
  if (!token.inlineValue && isOptionLikeValue(token.value)) {
    const example = token.rawName.startsWith("--") ? `'${token.rawName}=-XYZ'` : `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    const errorMessage = `Option '${token.rawName}' argument is ambiguous.
Did you forget to specify the option argument for '${token.rawName}'?
To specify an option argument starting with a dash use ${example}.`;
    throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", errorMessage);
  }
}

function checkOptionUsage(config, token) {
  if (!Object.hasOwn(config.options, token.name)) throw parseArgsUnknownOption(token.rawName, config.allowPositionals);
  const short = config.options[token.name].short;
  const shortAndLong = `${short ? `-${short}, ` : ""}--${token.name}`;
  const type = config.options[token.name].type;
  if (type === "string" && typeof token.value !== "string") {
    throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${shortAndLong} <value>' argument missing`);
  }
  if (type === "boolean" && token.value != null) {
    throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '${shortAndLong}' does not take an argument`);
  }
}

function storeOption(longOption, optionValue, options, values) {
  if (longOption === "__proto__") return;  /* no prototype pollution */
  const newValue = optionValue ?? true;
  if (options[longOption]?.multiple) {
    if (values[longOption] === undefined) values[longOption] = [newValue];
    else values[longOption].push(newValue);
  } else {
    values[longOption] = newValue;
  }
}

function storeDefaultOption(longOption, optionValue, values) {
  if (longOption === "__proto__") return;
  values[longOption] = optionValue;
}

/** The arguments as tokens: option, positional and option-terminator, with their indexes. */
function argsToTokens(args, options) {
  const tokens = [];
  let index = -1;
  let groupCount = 0;
  const remainingArgs = args.slice();
  while (remainingArgs.length > 0) {
    const arg = remainingArgs.shift();
    const nextArg = remainingArgs[0];
    if (groupCount > 0) groupCount--;
    else index++;

    /* everything after a bare `--` is a positional */
    if (arg === "--") {
      tokens.push({ kind: "option-terminator", index });
      for (const a of remainingArgs) tokens.push({ kind: "positional", index: ++index, value: a });
      break;
    }

    if (isLoneShortOption(arg)) {
      const shortOption = arg[1];
      const longOption = findLongOptionForShort(shortOption, options);
      let value;
      let inlineValue;
      if (options[longOption]?.type === "string" && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isShortOptionGroup(arg, options)) {
      /* `-abc`: each, the last of which may take the rest as its value */
      const expanded = [];
      for (let i = 1; i < arg.length; i++) {
        const shortOption = arg[i];
        const longOption = findLongOptionForShort(shortOption, options);
        if (options[longOption]?.type !== "string" || i === arg.length - 1) {
          expanded.push(`-${shortOption}`);
        } else {
          expanded.push(`-${arg.slice(i)}`);
          break;
        }
      }
      remainingArgs.unshift(...expanded);
      groupCount = expanded.length;
      continue;
    }

    if (isShortOptionAndValue(arg, options)) {
      const shortOption = arg[1];
      const longOption = findLongOptionForShort(shortOption, options);
      const value = arg.slice(2);
      tokens.push({ kind: "option", name: longOption, rawName: `-${shortOption}`, index, value, inlineValue: true });
      continue;
    }

    if (isLoneLongOption(arg)) {
      const longOption = arg.slice(2);
      let value;
      let inlineValue;
      if (options[longOption]?.type === "string" && isOptionValue(nextArg)) {
        value = remainingArgs.shift();
        inlineValue = false;
      }
      tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isLongOptionAndValue(arg)) {
      const equalIndex = arg.indexOf("=");
      const longOption = arg.slice(2, equalIndex);
      const value = arg.slice(equalIndex + 1);
      tokens.push({ kind: "option", name: longOption, rawName: `--${longOption}`, index, value, inlineValue: true });
      continue;
    }

    tokens.push({ kind: "positional", index, value: arg });
  }
  return tokens;
}

/* the arguments when none are given: the process's, after the executable (and the script, when
 * it's Node's) */
function getMainArgs() {
  const execArgv = process.execArgv ?? [];
  if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
    return process.argv.slice(1);
  }
  return process.argv.slice(2);
}

/** util.parseArgs({ args, options, strict, allowPositionals, allowNegative, tokens }). */
export function parseArgs(config = { __proto__: null }) {
  const args = config.args ?? getMainArgs();
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const returnTokens = config.tokens ?? false;
  const allowNegative = config.allowNegative ?? false;
  const options = config.options ?? { __proto__: null };
  const parseConfig = { args, strict, options, allowPositionals, allowNegative };

  validateArray(args, "args");
  validateBoolean(strict, "strict");
  validateBoolean(allowPositionals, "allowPositionals");
  validateBoolean(returnTokens, "tokens");
  validateBoolean(allowNegative, "allowNegative");
  validateObject(options, "options");
  for (const [longOption, optionConfig] of Object.entries(options)) {
    validateObject(optionConfig, `options.${longOption}`);
    validateUnion(optionConfig.type, `options.${longOption}.type`, ["string", "boolean"]);
    if (Object.hasOwn(optionConfig, "short")) {
      const shortOption = optionConfig.short;
      validateString(shortOption, `options.${longOption}.short`);
      if (shortOption.length !== 1) {
        throw invalidArgValue(`options.${longOption}.short`, "must be a single character", shortOption);
      }
    }
    const multipleOption = optionConfig.multiple;
    if (Object.hasOwn(optionConfig, "multiple")) validateBoolean(multipleOption, `options.${longOption}.multiple`);
    const defaultValue = optionConfig.default;
    if (defaultValue !== undefined) {
      let validator;
      switch (optionConfig.type) {
        case "string":
          validator = multipleOption ? validateStringArray : validateString;
          break;
        case "boolean":
          validator = multipleOption ? validateBooleanArray : validateBoolean;
          break;
      }
      validator(defaultValue, `options.${longOption}.default`);
    }
  }

  const tokens = argsToTokens(args, options);
  const result = { values: { __proto__: null }, positionals: [] };
  if (returnTokens) result.tokens = tokens;

  for (const token of tokens) {
    if (token.kind === "option") {
      if (allowNegative && token.name.startsWith("no-")) {
        /* --no-foo: foo false, when foo is a boolean option */
        const longOption = token.name.slice(3);
        const optionConfig = options[longOption];
        if (optionConfig?.type === "boolean") {
          if (token.value !== undefined) {
            throw codeError(TypeError, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `Option '--${longOption}' does not take an argument`);
          }
          storeOption(longOption, false, options, result.values);
          continue;
        }
      }
      if (strict) {
        checkOptionUsage(parseConfig, token);
        checkOptionLikeValue(token);
      }
      storeOption(token.name, token.value, options, result.values);
    } else if (token.kind === "positional") {
      if (!allowPositionals) {
        throw codeError(TypeError, "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", `Unexpected argument '${token.value}'. This command does not take positional arguments`);
      }
      result.positionals.push(token.value);
    }
  }

  for (const [longOption, optionConfig] of Object.entries(options)) {
    const mustSetDefault = useDefaultValueOption(longOption, optionConfig, result.values);
    if (mustSetDefault) storeDefaultOption(longOption, optionConfig.default, result.values);
  }

  return result;
}

features.parseArgs = parseArgs;
