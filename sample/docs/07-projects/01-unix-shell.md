# Unix Shell

> **What this teaches**: The Unix process model in your hands — `fork`, `exec`, `wait`, file-descriptor inheritance, pipes, redirection, signals, and the minimum viable job control. Every `Dockerfile` line, every CI step, every container runtime is built from these same five system calls. Until you write a shell, those calls are abstract; afterward, they are muscle memory.

**Language**: C
**Effort**: 2–3 days for a usable shell with pipes, redirection, and `&`. Another week if you chase job control.
**Companion reads**: 7.4 HTTP server (the next thing built from `fork`-shaped concurrency), 7.5 epoll chat server (the model that *replaces* `fork`-per-client).

---

## 1. Why this matters

A shell is a program whose only job is to **launch other programs**. That sounds trivial until you sit down and write one. The system calls behind it — `fork`, `execve`, `waitpid`, `pipe`, `dup2`, `signal`/`sigaction`, `setpgid` — are the foundation of every process-orchestration tool you have ever used:

- Docker's `RUN` is `fork` + `execve` + `waitpid`.
- A CI runner is a shell loop over a YAML file.
- `make -j` is parallel `fork`/`exec` with dependency tracking.
- `systemd` is a shell that never exits.

The shell exists because Unix has two complementary primitives that *together* are surprisingly powerful: **`fork`** creates a new process that is an exact copy of the caller; **`exec`** replaces the current process's program image with a new one. Every other process model in mainstream computing (Windows `CreateProcess`, `posix_spawn`, `fork`/`exec` itself) is some collapse or specialization of these two.

Writing a shell forces you to internalize:

1. **What does a child inherit?** File descriptors, environment, working directory, signal dispositions, the process group.
2. **What does a parent need to do?** Reap zombies, route signals, manage process groups for the terminal.
3. **What is a pipe, really?** A kernel buffer with a read end and a write end, both inherited across `fork`.

After this project the words "file descriptor 0" and "process group leader" stop being jargon and start being objects you can name in your head.

---

## 2. The mental model

A shell's main loop is four steps, forever:

```
loop:
  print prompt
  read a line from stdin
  parse it into a command tree (with pipes, redirects, &)
  execute the tree
```

Execution itself is recursive. A "command" can be:

- A **builtin** (`cd`, `exit`, `export`) — runs in the shell process directly. `cd` *must* be a builtin because `fork` + `exec`-of-`cd` would change the directory of the child only, then exit. There is no external `cd` binary anywhere on your system.
- An **external command** — `fork`, then in the child `execve`, then in the parent `waitpid`.
- A **pipeline** `A | B | C` — `fork` once per stage, wire up pipes between them, then `waitpid` on the last one.
- A **redirected command** `A > out` — `fork`, then in the child `open(out)` and `dup2` it onto fd 1 *before* `exec`.
- A **background command** `A &` — same as foreground but don't `waitpid`.

The single most important thing to internalize: **all setup of fds and process groups happens in the child between `fork` and `exec`.** The child is a perfect copy of the shell until `exec`, so any rearrangement of its environment is just normal C code in the child — `dup2`, `close`, `chdir`, `setpgid` — and then `execve` "commits" by replacing the program.

---

## 3. Skeleton: the read-eval loop

We'll build this in four layers: skeleton → externals → pipes → redirection + background. Builtins and job control come last.

```c
// shell.h
#ifndef SHELL_H
#define SHELL_H

#include <stddef.h>

typedef struct Command {
    char  **argv;       // NULL-terminated
    char   *in_file;    // < in_file (NULL if none)
    char   *out_file;   // > out_file (NULL if none)
    int     append;     // >> if true
} Command;

typedef struct Pipeline {
    Command *stages;    // stages[0] | stages[1] | ...
    size_t   n_stages;
    int      background; // ended with &
} Pipeline;

Pipeline *parse_line(char *line);
int       run_pipeline(Pipeline *p);
void      pipeline_free(Pipeline *p);

#endif
```

```c
// main.c
#include "shell.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char *line = NULL;
    size_t cap = 0;
    for (;;) {
        if (isatty(STDIN_FILENO)) {
            fputs("$ ", stdout);
            fflush(stdout);
        }
        ssize_t n = getline(&line, &cap, stdin);
        if (n < 0) break;                          // EOF (Ctrl-D)
        if (n > 0 && line[n-1] == '\n') line[n-1] = 0;
        if (line[0] == 0) continue;
        Pipeline *p = parse_line(line);
        if (!p) { fprintf(stderr, "parse error\n"); continue; }
        run_pipeline(p);
        pipeline_free(p);
    }
    free(line);
    return 0;
}
```

That's the entire skeleton. Everything else is filling in `parse_line` and `run_pipeline`.

---

## 4. Single external command

Start with the simplest case: one command, no pipes, no redirects.

```c
#include <sys/wait.h>

static int run_single(Command *c) {
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return -1; }

    if (pid == 0) {
        // child
        execvp(c->argv[0], c->argv);
        // exec only returns on failure
        perror(c->argv[0]);
        _exit(127);                                 // 127 = command not found, by convention
    }
    // parent
    int status;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
```

**Three subtleties** that bite everyone the first time:

1. **`_exit`, not `exit`, in the child after `exec` failure.** `exit` runs `atexit` handlers and flushes `stdio` buffers — including ones inherited from the parent — which can double-print output. `_exit` goes straight to the kernel.
2. **`execvp` returns only on failure.** If it succeeds, the program image is replaced and you never come back. So the `perror` after it is the "exec failed" branch — no `if` needed.
3. **The exit-status convention.** `waitpid` packs the exit code into the top bits and the signal that killed the process into the bottom bits. Shells universally report `128 + signal` for signal deaths so that `echo $?` distinguishes "exited with 137" (e.g., OOM-killed → 128 + 9) from "exited cleanly with 137."

---

## 5. Pipes

A pipeline `A | B` is two children, with B's stdin wired to A's stdout via a `pipe()`. The kernel call `pipe(fds)` returns a pair: `fds[0]` is the read end, `fds[1]` is the write end. Whatever is written to `fds[1]` becomes readable on `fds[0]`, with the kernel providing a small (~64 KB) buffer in between.

The trick is **fd discipline**: after `fork`, *both* parent and child have *both* ends. You must close the ends you don't need in each process, otherwise the reader will never see EOF (because the kernel waits for *all* write ends, in every process, to close).

```c
static int run_pipeline_n(Command *stages, size_t n) {
    int prev_read = -1;
    pid_t *pids = calloc(n, sizeof(pid_t));

    for (size_t i = 0; i < n; i++) {
        int pipefd[2] = {-1, -1};
        if (i + 1 < n) {
            if (pipe(pipefd) < 0) { perror("pipe"); return -1; }
        }
        pid_t pid = fork();
        if (pid == 0) {
            // child
            if (prev_read != -1) {
                dup2(prev_read, STDIN_FILENO);
                close(prev_read);
            }
            if (i + 1 < n) {
                close(pipefd[0]);
                dup2(pipefd[1], STDOUT_FILENO);
                close(pipefd[1]);
            }
            execvp(stages[i].argv[0], stages[i].argv);
            perror(stages[i].argv[0]);
            _exit(127);
        }
        // parent
        pids[i] = pid;
        if (prev_read != -1) close(prev_read);
        if (i + 1 < n) {
            close(pipefd[1]);                       // parent never writes
            prev_read = pipefd[0];                  // hand to next stage
        }
    }
    int last_status = 0;
    for (size_t i = 0; i < n; i++) waitpid(pids[i], i + 1 == n ? &last_status : NULL, 0);
    free(pids);
    return WIFEXITED(last_status) ? WEXITSTATUS(last_status) : 128 + WTERMSIG(last_status);
}
```

Read the loop slowly. The invariant is:

> Before iteration `i` runs, `prev_read` (if not -1) is the read end of the pipe whose write end was used by stage `i-1`. After iteration `i`, `prev_read` holds the read end of the pipe whose write end was used by stage `i`.

The two `close`s after `dup2` are not optional. `dup2(a, b)` makes `b` an alias for the file *table entry* `a` points to; `a` itself is still open. Forgetting to close `a` leaks a descriptor (in the child) and, worse, can leave the kernel pipe write end open in some forgotten process — which means the reader hangs at EOF forever.

**The exit status of a pipeline is the exit status of the last stage.** This is POSIX. Many shells (bash with `set -o pipefail`) override this. Note also that we `waitpid` on every child — not just the last one — so they don't pile up as zombies.

---

## 6. Redirection

`>`, `>>`, `<` are nearly identical to pipe wiring — same `dup2` pattern, different fd source. Do them in the child, just before `exec`:

```c
static void apply_redirs(Command *c) {
    if (c->in_file) {
        int fd = open(c->in_file, O_RDONLY);
        if (fd < 0) { perror(c->in_file); _exit(1); }
        dup2(fd, STDIN_FILENO);
        close(fd);
    }
    if (c->out_file) {
        int flags = O_WRONLY | O_CREAT | (c->append ? O_APPEND : O_TRUNC);
        int fd = open(c->out_file, flags, 0644);
        if (fd < 0) { perror(c->out_file); _exit(1); }
        dup2(fd, STDOUT_FILENO);
        close(fd);
    }
}
```

Call `apply_redirs(&stages[i])` after the pipe `dup2`s but before `execvp`. **Redirection wins over pipes** when both are present on the same stage — this is what bash does, and it falls out for free here because the file `dup2` happens last.

---

## 7. Background commands (`&`)

Trivial after the above: don't `waitpid` on the last stage. Print the PID so the user can refer to it.

```c
if (pipeline->background) {
    printf("[%d]\n", pids[n - 1]);
} else {
    for (size_t i = 0; i < n; i++)
        waitpid(pids[i], i + 1 == n ? &last_status : NULL, 0);
}
```

But now you have a problem: those background processes will exit at some point, and become **zombies** sitting in the process table until you `waitpid` them. The fix is a `SIGCHLD` handler that reaps non-blockingly:

```c
#include <signal.h>

static void sigchld_reaper(int sig) {
    (void)sig;
    int saved_errno = errno;
    while (waitpid(-1, NULL, WNOHANG) > 0) { }
    errno = saved_errno;
}

// in main, before the loop:
struct sigaction sa = { .sa_handler = sigchld_reaper, .sa_flags = SA_RESTART | SA_NOCLDSTOP };
sigemptyset(&sa.sa_mask);
sigaction(SIGCHLD, &sa, NULL);
```

`WNOHANG` returns immediately if no child has exited; the `while` loop drains *every* exited child each time the handler fires, because signals can coalesce — if two children exit nearly simultaneously, you might only get one `SIGCHLD`. Forgetting the loop leaves a zombie behind every few `&` invocations.

`SA_RESTART` makes blocked syscalls (`read` on stdin) restart instead of returning `EINTR`. `SA_NOCLDSTOP` says "don't fire on stop/continue, only on exit."

---

## 8. Builtins

`cd`, `exit`, `export`, `unset`, `pwd` must run in the shell process. The dispatch is one line:

```c
static int try_builtin(Command *c) {
    if (strcmp(c->argv[0], "cd") == 0) {
        const char *target = c->argv[1] ? c->argv[1] : getenv("HOME");
        if (chdir(target) < 0) perror("cd");
        return 1;                                   // handled
    }
    if (strcmp(c->argv[0], "exit") == 0) exit(c->argv[1] ? atoi(c->argv[1]) : 0);
    return 0;                                       // not a builtin
}
```

Call before `fork` for single-stage pipelines. In a multi-stage pipeline (`cd /tmp | cat`), bash runs `cd` in a subshell and discards the effect — this is a famous footgun and you should mirror it for compatibility.

---

## 9. Parsing

The parser is the boring part. A reasonable strategy for the shell-without-quoting-rules:

```
line       := pipeline ('&'?)
pipeline   := command ('|' command)*
command    := word (word | redir)*
redir      := ('<' | '>' | '>>') word
word       := [^\s|<>&]+
```

A hand-rolled recursive-descent parser is ~150 lines. Tokenize first into a vector of `(kind, text)` pairs (`WORD`, `PIPE`, `LT`, `GT`, `GTGT`, `AMP`, `EOL`); then walk the tokens, allocating `Command`s. **Don't** try to handle quoting, variable expansion, globbing, or backticks in v1. Those are each a project of their own.

A short word on quoting: real shells expand `$VAR` *after* tokenization but *before* `exec`. Globbing happens after that. The expansion order is the source of approximately 40% of all shell bugs, including the famous `rm -rf "$STEAM_ROOT/"*` that deleted Steam users' home directories in 2015 (`$STEAM_ROOT` was empty, glob expanded `/*`).

---

## 10. Job control (the part you skip the first time)

Job control is what makes `Ctrl-Z` suspend a process and `fg`/`bg` resume it. It is **fiddly** and not pedagogically critical, but if you want a real shell, here is the shape:

1. The shell puts each pipeline in its own **process group** with `setpgid(pid, pid)` (also in the child, to avoid a race).
2. The shell tells the terminal which process group is the foreground with `tcsetpgrp(STDIN_FILENO, pgid)`.
3. When the pipeline finishes or is stopped, the shell calls `tcsetpgrp` to put itself back in the foreground.
4. The shell must ignore `SIGTTOU`, `SIGTTIN`, `SIGTSTP`, `SIGINT`, `SIGQUIT` (so it doesn't get suspended along with its children).
5. `fg %1` looks up job 1 in the shell's job table, `tcsetpgrp`s back to it, and sends `SIGCONT` to its process group.

This is a week of work and the source of a *huge* number of subtle bugs in pre-1990s shells. Modern guides (Stevens, *Advanced Programming in the UNIX Environment*) walk through it in 30 pages.

---

## 11. Common pitfalls

1. **Forgetting to close pipe ends in the parent.** The reader hangs forever waiting for EOF that never comes.
2. **Calling `exit` instead of `_exit` in the child after exec failure.** Duplicate output, flushed stdio buffers, surprise behavior.
3. **Not reaping zombies.** Run `ps` after launching 50 background commands; the zombies are still in the process table.
4. **Forgetting `SA_RESTART`.** Every `getline` returns `EINTR` the moment a child dies, and you wonder why your prompt re-prints constantly.
5. **Writing `cd` as an external command.** Won't work. Has to be a builtin. (Same for `exit`, `export`, `umask`, `ulimit`.)
6. **Race in process-group setup.** If the parent calls `setpgid(child, child)` but the child has already `exec`ed and called something that depends on its pgid, you have a TOCTOU. Standard fix: *both* parent and child call `setpgid` with the same args; whichever wins first, the other is a no-op.
7. **Trying to support full POSIX quoting in v1.** This is a multi-week project on its own. Get pipes working first.

---

## 12. Variations you'll encounter in the wild

- **`dash`** — small POSIX-compliant shell, ~20k LOC. The canonical "I want to read shell source code."
- **`busybox` `sh`** (Almquist shell descendant) — ~30k LOC. Used in Alpine Linux, basically every container.
- **`bash`** — ~200k LOC. Way more than you need to read.
- **`fish`** — modern, opinionated, autosuggest UI. Different philosophy.
- **`xonsh`** — Python-flavored shell. Shows the design space isn't fixed.
- **`oil` / `osh`** — Andy Chu's project, explicitly designed for *replacing* bash while staying compatible. The `oil` blog is one of the best sources on why shell semantics are the way they are.

---

## 13. Where this shows up in the real world

- **Container runtimes** (`runc`, `containerd-shim`) — basically `clone()` + `execve()` + namespace setup. Conceptually a shell that runs one command.
- **CI runners** (GitHub Actions, GitLab Runner) — a shell loop over a YAML-defined job graph.
- **`make`, `ninja`, `bazel`** — parallel `fork`/`exec` with dependency DAGs on top.
- **`systemd`** — PID 1, the "shell that never exits," doing the same `fork`/`exec`/`waitpid` dance for every service.
- **`xargs -P`, GNU `parallel`** — `fork`/`exec` orchestration with a worker pool.

---

## 14. Going deeper

1. **Add `$?`, `$$`, and basic `$VAR` expansion.** Shows you how expansion ordering interacts with quoting.
2. **Add globbing with `glob(3)`.** Surprisingly easy with the libc helper; instructive to write the matcher by hand.
3. **Add heredocs (`<<EOF`).** A small pipe to a temporary fd; teaches `dup2` from a different angle.
4. **Add command substitution (`` `cmd` `` and `$(cmd)`).** A nested `fork`/`exec` with a `pipe()` to capture stdout.
5. **Implement job control end-to-end.** `bg`, `fg`, `jobs`, `Ctrl-Z`. The full Stevens chapter.
6. **Read `dash`'s `jobs.c` and `eval.c`.** ~3000 lines combined, very clean.

---

## 15. Industry context

> Shells are one of the oldest abstractions in computing that has not been displaced. The reason they survive is that *the process model is genuinely useful*, and shells expose it directly.

- **Active debate**: "Should we standardize a sane shell language?" — `oil`, `nushell`, and `pwsh` (PowerShell) are all attempts. None has displaced bash, because bash's *integration with everything* matters more than its quality as a language.
- **Historical context**: The Bourne shell (1977) introduced the `fork`/`exec`/redirect model in essentially its modern form. Korn shell (1983) added job control, arithmetic, arrays. Bash (1989) was the GNU clone. The reason most shells still feel 1977-ish is that the *kernel API* they sit on top of is still 1977-ish.
- **What a tech lead would ask**: "How does your pipeline propagate failures?" (POSIX: last stage only; `pipefail`: any stage). "How do you handle SIGPIPE in writers?" (the early stage of `yes | head` exits on SIGPIPE — make sure you don't ignore it shell-wide). "What's the exit status of `false | true`?" (0, unless `pipefail`).
- **Forward-looking**: Container-init systems (`tini`, `dumb-init`) are *minimal shells without the parsing* — they exist solely to be PID 1 and reap zombies. The shell model isn't going anywhere.
- **Names worth knowing**: Stephen Bourne (sh), David Korn (ksh), Brian Fox (bash), Andy Chu (oil), Rob Pike (rc / Plan 9 shell — a beautiful alternate design).

---

## 16. Self-check questions

Before declaring yourself done, can you answer these without looking?

1. Why must `cd` be a builtin?
2. What does the kernel do when a process exits without anyone `waitpid`ing it?
3. Why do you have to close the parent's copy of pipe ends after `fork`?
4. Why `_exit` and not `exit` in the failed-`exec` branch?
5. What does `dup2(a, b)` do to fd `a`?
6. What is the exit status of `cmd1 | cmd2 | false` in POSIX mode?
7. Why does a `SIGCHLD` handler need a `while (waitpid(... WNOHANG) > 0)` loop?

If you can answer these crisply, you have internalized the Unix process model at a level most application programmers never reach.
