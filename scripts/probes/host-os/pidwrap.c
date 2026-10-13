// Fork short-lived children until one receives TARGET, then that child execs
// `sleep 600` in its own session. Prints "found <pid> <forks> <ms>" or
// "foreign <pid>" (another process took TARGET first) or "timeout".
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: pidwrap TARGET WORKERS SECONDS\n"); return 2; }
  pid_t target = (pid_t)atoi(argv[1]);
  int workers = atoi(argv[2]);
  double limit = atof(argv[3]) * 1e3, start = now_ms();
  int fds[2]; if (pipe(fds)) return 3;
  pid_t ids[256];
  for (int w = 0; w < workers; w++) {
    pid_t id = fork();
    if (id == 0) {
      close(fds[0]);
      long forks = 0;
      for (;;) {
        pid_t child = fork();
        if (child == 0) {
          if (getpid() == target) { setsid(); int n = open("/dev/null", O_RDWR); dup2(n, 0); dup2(n, 1); dup2(n, 2); close(fds[1]); execl("/bin/sleep", "sleep", "600", (char *)0); }
          _exit(0);
        }
        forks++;
        if (child == target) { dprintf(fds[1], "found %d %ld\n", child, forks); _exit(0); }
        if (child > 0) waitpid(child, 0, 0);
        if ((forks & 1023) == 0) {
          if (kill(target, 0) == 0 || errno == EPERM) { dprintf(fds[1], "foreign %d %ld\n", target, forks); _exit(0); }
          if (now_ms() - start > limit) { dprintf(fds[1], "timeout 0 %ld\n", forks); _exit(0); }
        }
      }
    }
    ids[w] = id;
  }
  close(fds[1]);
  char line[128]; FILE *in = fdopen(fds[0], "r");
  if (!fgets(line, sizeof line, in)) return 4;
  for (int w = 0; w < workers; w++) kill(ids[w], SIGKILL);
  for (int w = 0; w < workers; w++) waitpid(ids[w], 0, 0);
  line[sizeof line - 1] = 0;
  char kind[16]; int pid; long forks;
  sscanf(line, "%15s %d %ld", kind, &pid, &forks);
  printf("%s %d %ld %.0f\n", kind, pid, forks, now_ms() - start);
  return 0;
}
