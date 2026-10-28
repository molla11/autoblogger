import path from 'node:path';

export interface ParsedCommand {
  kind: 'compile' | 'execute' | 'python' | 'compile_run';
  source?: string;
  executable?: string;
  input?: string;
}

/** Conservative shell tokenizer, never evaluation. Unsupported composition is deliberately unrecorded. */
export function tokenizeShell(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (quote === '"' && (c === '$' || c === '`')) return undefined;
      if (quote === '"' && c === '\\' && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) current += command[++i];
      else current += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '\\') { if (i + 1 >= command.length) return undefined; current += command[++i]; started = true; }
    else if (c === '$' || c === '`' || c === '(' || c === ')' || c === '\n') return undefined;
    else if (/\s/.test(c)) { if (started) { tokens.push(current); current = ''; started = false; } }
    else if ('&|;<>'.includes(c)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      if (command[i + 1] === c) tokens.push(c + command[++i]); else tokens.push(c);
    } else if (c === '#' && !started) break;
    else { current += c; started = true; }
  }
  if (quote) return undefined;
  if (started) tokens.push(current);
  return tokens;
}

function cleanRedirect(tokens: string[]): {args: string[]; input?: string} | undefined {
  const args: string[] = []; let input: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '<') {
      if (input || !tokens[i + 1] || /^[&|;<>]+$/.test(tokens[i + 1])) return undefined;
      input = tokens[++i];
    } else if (tokens[i] === '>' || tokens[i] === '>>') {
      if (!tokens[i + 1] || /^[&|;<>]+$/.test(tokens[i + 1])) return undefined;
      if (args.length && /^\d+$/.test(args[args.length - 1])) args.pop();
      i++;
    } else if (/^[&|;<>]+$/.test(tokens[i])) return undefined;
    else args.push(tokens[i]);
  }
  return {args, input};
}

function simple(tokens: string[], cwd: string): ParsedCommand | undefined {
  const clean = cleanRedirect(tokens);
  if (!clean || !clean.args.length) return undefined;
  const {args} = clean;
  const command = path.basename(args[0]);
  const input = clean.input ? path.resolve(cwd, clean.input) : undefined;
  if (/^(gcc|g\+\+|clang|clang\+\+)(?:-\d+)?$/.test(command)) {
    const sources = args.slice(1).filter(arg => /\.(c|cpp)$/i.test(arg));
    if (sources.length !== 1 || args.includes('-c') || args.includes('-E') || args.includes('-S')) return undefined;
    const index = args.indexOf('-o');
    if (index >= 0 && !args[index + 1]) return undefined;
    const output = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('-o') && arg.length > 2)?.slice(2) ?? 'a.out';
    return {kind:'compile', source:path.resolve(cwd, sources[0]), executable:path.resolve(cwd, output), input};
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(command)) {
    let index = 1;
    while (index < args.length && args[index].startsWith('-')) {
      if (['-c', '-m', '-'].includes(args[index])) return undefined;
      if (['-W','-X','--check-hash-based-pycs'].includes(args[index])) index++;
      index++;
    }
    if (!args[index] || !/\.py$/i.test(args[index])) return undefined;
    return {kind:'python',source:path.resolve(cwd,args[index]),input};
  }
  if (args[0].startsWith('./')) return {kind:'execute', executable:path.resolve(cwd,args[0]),input};
  return undefined;
}

export function parseCommand(command: string, cwd: string): ParsedCommand | undefined {
  const tokens = tokenizeShell(command);
  if (!tokens) return undefined;
  const split = tokens.indexOf('&&');
  if (split < 0) return simple(tokens,cwd);
  const compile = simple(tokens.slice(0,split),cwd);
  const run = simple(tokens.slice(split + 1),cwd);
  if (compile?.kind !== 'compile' || run?.kind !== 'execute' || compile.executable !== run.executable) return undefined;
  return {...compile,kind:'compile_run',input:run.input};
}

export function runStatus(kind: ParsedCommand['kind'], exitCode: number | undefined, output: string): {
  status: 'compile_error' | 'runtime_error' | 'success' | 'unknown'; signal?: number;
} {
  if (exitCode === undefined) return {status:'unknown'};
  if (exitCode === 0) return {status:'success'};
  if (kind === 'compile' || (kind === 'python' && /(?:SyntaxError|IndentationError|TabError):/.test(output)) ||
    (kind === 'compile_run' && /:\d+(?::\d+)?:\s*(?:fatal\s+)?error:|undefined reference to|(?:collect2|ld|clang\+\+|g\+\+):\s*(?:fatal\s+)?error:/i.test(output))) return {status:'compile_error'};
  return {status:'runtime_error', ...(exitCode > 128 ? {signal:exitCode - 128} : {})};
}
