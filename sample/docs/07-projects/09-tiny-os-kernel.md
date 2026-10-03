# Tiny OS Kernel

> **What this teaches**: Everything underneath every program you've ever run. Freestanding C, the boot path, the GDT/IDT, paging, interrupts, VGA text output. Running your own kernel under QEMU and seeing it print "hello, kernel" is one of the most permanently mind-changing experiences in a programmer's life.

**Language**: C + a little x86 / x86_64 assembly. (ARM is also reasonable; the structure is the same, the specific tables differ.)
**Effort**: 1–3 weeks for boot + interrupts + paging + a tiny shell. Months if you keep adding features.
**Companion reads**: 7.1 unix shell (the user-space analog), 7.3 malloc (the same problem, one ring up), 7.5 epoll chat server (after this, you'll understand what `epoll` is actually asking the kernel to do).

---

## 1. Why this matters

Most programmers spend their entire careers writing code that runs on top of an operating system without ever having seen what's underneath. They know "the kernel handles that" but cannot name a single concrete mechanism. After writing even a 500-line kernel, you understand:

- **What the CPU does at boot.** Real mode → protected/long mode is a specific sequence of instructions, not magic.
- **What an interrupt actually is.** A hardware signal that suspends your code, looks up a function pointer in a table, runs it, restores state. That's it.
- **What virtual memory is.** A specific tree of pages the CPU walks on every load and store. Page faults are this tree saying "nope."
- **What system calls are.** A specific instruction (`syscall` on x86_64, `svc` on ARM) that traps into ring 0 with arguments in registers.
- **What "the scheduler" does.** Saves one register set, loads another, jumps. ~30 instructions.

This is the project that makes every other systems project on this list re-resolve to a deeper level. You can't unsee it.

---

## 2. The mental model

The CPU boots in **real mode** (8086-compatible, 16-bit, 1 MB of memory, no protection). The BIOS or UEFI loads your **bootloader** (512 bytes from sector 0 of the boot disk) at address `0x7c00`. The bootloader's job is to:

1. Switch the CPU into **protected mode** (32-bit) or **long mode** (64-bit).
2. Set up a basic memory map.
3. Load your kernel into memory.
4. Jump to the kernel's entry point.

The kernel then:

1. Sets up the **GDT** (Global Descriptor Table) — describes memory segments and CPU privilege levels.
2. Sets up the **IDT** (Interrupt Descriptor Table) — maps interrupt numbers to handler functions.
3. Enables **paging** — turns on virtual memory.
4. Initializes a few devices (timer, keyboard, serial, VGA).
5. Runs the first thread.

```
   power on
      │
      ▼
   BIOS/UEFI ── loads ──▶ bootloader (sector 0, 512 B)
                              │
                              │ switches CPU mode, loads kernel
                              ▼
                          kernel start
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
            set GDT        set IDT        enable paging
                              │
                              ▼
                      init devices (timer, kbd)
                              │
                              ▼
                       enter scheduler / shell loop
```

Three things to internalize:

- **The bootloader is a separate program.** It's not "the start of your kernel." It runs first, prepares the environment, and hands off.
- **Everything below the kernel is concrete hardware tables.** GDT entries are 8 bytes each. IDT entries are 8 or 16 bytes. Page table entries are 8 bytes. You write structs and the CPU reads them — that's the contract.
- **The skip from "writing user-space C" to "writing a kernel" is mostly conceptual.** It's still C. You just have no stdlib, no printf, no malloc until you write them yourself.

---

## 3. The toolchain

You need to **cross-compile** because the kernel is not a Linux/macOS binary. Conventional setup:

- A GCC cross-compiler targeting `i686-elf` (32-bit) or `x86_64-elf` (64-bit). Build it once from the GCC source; takes an afternoon.
- `nasm` for the assembly bootloader stub and the assembly entry points.
- `qemu-system-i386` or `qemu-system-x86_64` to run the kernel without rebooting your machine.
- A linker script (`linker.ld`) that places sections at the addresses the bootloader expects.

The single-best shortcut: **use the [Multiboot specification](https://www.gnu.org/software/grub/manual/multiboot/multiboot.html)** and let GRUB be your bootloader. You write a 30-byte Multiboot header at the top of your kernel; GRUB loads you into protected mode, sets up a basic memory map, and jumps to your `_start`. This skips the entire "writing a 512-byte bootloader" project, which is its own week.

(Skipping the bootloader is *fine* for an educational kernel. Writing one yourself is a separate project — see the "Going deeper" section.)

---

## 4. The kernel entry point

```nasm
; boot.asm
section .multiboot
align 4
    dd 0x1BADB002                 ; multiboot magic
    dd 0x00000003                 ; flags: page-align modules, give us memory info
    dd -(0x1BADB002 + 0x00000003) ; checksum

section .bss
align 16
stack_bottom:
    resb 16384                    ; 16 KB stack
stack_top:

section .text
global _start
extern kernel_main
_start:
    mov esp, stack_top            ; set up the stack
    call kernel_main              ; into C-land
.hang:
    cli                           ; disable interrupts
    hlt                           ; halt CPU
    jmp .hang
```

The `multiboot` section tells GRUB "I am a Multiboot-compliant kernel." The `_start` label is the kernel's first instruction; it sets up a stack (the BIOS/GRUB doesn't give us one!) and calls our C `kernel_main`.

```c
// kernel.c
void kernel_main(void) {
    vga_init();
    vga_writestring("Hello, kernel world!\n");
    for (;;) asm("hlt");
}
```

That, plus the linker script, plus a Makefile, gets you a kernel that boots in QEMU and prints text. ~200 lines total. **This is the moment that changes you.**

---

## 5. The VGA text buffer

The simplest output device in PC history. At physical address `0xB8000` is a 25×80 character grid; each cell is 2 bytes (ASCII + color attribute). Writing to it draws on screen.

```c
#define VGA_BUFFER ((volatile uint16_t*)0xB8000)
#define VGA_WIDTH  80
#define VGA_HEIGHT 25

static size_t vga_row = 0, vga_col = 0;
static uint8_t vga_color = 0x0F;     // white on black

void vga_putchar(char c) {
    if (c == '\n') { vga_col = 0; vga_row++; }
    else {
        VGA_BUFFER[vga_row * VGA_WIDTH + vga_col] = ((uint16_t)vga_color << 8) | (uint8_t)c;
        vga_col++;
        if (vga_col >= VGA_WIDTH) { vga_col = 0; vga_row++; }
    }
    if (vga_row >= VGA_HEIGHT) vga_row = 0; // wrap; real scrolling is one memcpy
}
```

There is no library between you and the screen. There is no driver. You write to memory and the hardware shows it. **This is the most viscerally satisfying line of code in the project**, because most programmers go their entire careers without doing it directly.

---

## 6. The GDT (in 30 lines)

The Global Descriptor Table tells the CPU how to interpret segment selectors. In long mode it's mostly vestigial — you need it set up correctly but you'll only use four entries: null, kernel code, kernel data, user code. (Well, six — user data, TSS for syscalls.)

```c
typedef struct {
    uint16_t limit_low;
    uint16_t base_low;
    uint8_t  base_mid;
    uint8_t  access;
    uint8_t  granularity;
    uint8_t  base_high;
} __attribute__((packed)) GDTEntry;

typedef struct {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed)) GDTPointer;

static GDTEntry gdt[5];
static GDTPointer gdtp;

void gdt_init(void) {
    gdt_set(0, 0, 0, 0, 0);                       // null
    gdt_set(1, 0, 0xFFFFF, 0x9A, 0xAF);           // kernel code
    gdt_set(2, 0, 0xFFFFF, 0x92, 0xCF);           // kernel data
    gdt_set(3, 0, 0xFFFFF, 0xFA, 0xAF);           // user code
    gdt_set(4, 0, 0xFFFFF, 0xF2, 0xCF);           // user data
    gdtp.limit = sizeof(gdt) - 1;
    gdtp.base  = (uint64_t)&gdt;
    asm volatile ("lgdt (%0)" :: "r"(&gdtp));
    // far-jump to reload CS, mov to reload DS/ES/SS, etc.
}
```

Every byte of the access and granularity fields has a meaning documented in the Intel manuals (volume 3, chapter 3). You will read this table by hex code dozens of times. The numbers `0x9A`, `0x92`, `0xFA`, `0xF2` will become as familiar to you as `0644` is now.

---

## 7. The IDT and interrupts

The IDT maps interrupt numbers (0–255) to handler functions. Interrupts 0–31 are CPU exceptions (divide by zero, page fault, double fault, …). 32–47 are typically remapped hardware IRQs (timer, keyboard). Everything above is software-triggerable.

```c
typedef struct {
    uint16_t offset_low;
    uint16_t selector;
    uint8_t  ist;
    uint8_t  flags;
    uint16_t offset_mid;
    uint32_t offset_high;
    uint32_t reserved;
} __attribute__((packed)) IDTEntry;

extern void isr0(void);    // defined in assembly
extern void isr1(void);
extern void isr14(void);   // page fault
// ...

void idt_init(void) {
    idt_set(0,  (uint64_t)isr0,  0x08, 0x8E);
    idt_set(14, (uint64_t)isr14, 0x08, 0x8E);
    // ...
    lidt(&idtp);
}
```

Each handler is a few lines of assembly that saves registers, calls into C, restores registers, and `iret`s back. The pattern is identical across all interrupts:

```nasm
isr14:
    push rax
    push rcx
    ; ... push remaining registers ...
    mov rdi, 14                    ; first arg to C handler
    call interrupt_handler
    ; ... pop registers ...
    iretq
```

The C handler is just a switch on the vector number:

```c
void interrupt_handler(uint64_t vector, uint64_t error_code) {
    switch (vector) {
        case 14: page_fault_handler(error_code); break;
        case 32: timer_tick(); break;
        case 33: keyboard_irq(); break;
        default: printf("unhandled interrupt %lu\n", vector);
    }
    // for IRQs, send EOI to the PIC/APIC
}
```

Suddenly "the kernel handles a page fault" becomes a literal C switch statement you wrote.

---

## 8. Paging

The CPU walks a 4-level tree (on x86_64) on *every* memory access:

```
   CR3 register ──▶ PML4 (top level)
                       │ [bits 47:39 of virt addr]
                       ▼
                    PDP
                       │ [bits 38:30]
                       ▼
                    PD
                       │ [bits 29:21]
                       ▼
                    PT
                       │ [bits 20:12]
                       ▼
                    physical page (low 12 bits = page offset)
```

Each level is a 4 KB page containing 512 entries, each 8 bytes. Each entry is `[physical page address | flags]`. Flags include "present," "writable," "user-accessible," "no-execute."

For a teaching kernel, **identity-map the lower 4 GB** (virtual address X == physical address X) and you're done. That avoids the chicken-and-egg of "where do my page tables live before paging is on."

```c
static uint64_t pml4[512] __attribute__((aligned(4096)));
static uint64_t pdp[512]  __attribute__((aligned(4096)));
static uint64_t pd[2048]  __attribute__((aligned(4096))); // 4 PD tables for 4 GB

void paging_init(void) {
    for (int i = 0; i < 2048; i++) {
        pd[i] = (i * 0x200000) | 0x83;  // present, writable, 2MB page
    }
    for (int i = 0; i < 4; i++) {
        pdp[i] = ((uint64_t)&pd[i * 512]) | 0x03;
    }
    pml4[0] = ((uint64_t)pdp) | 0x03;
    asm volatile ("mov %0, %%cr3" :: "r"(pml4));
}
```

That's a working virtual memory system. From here, every interesting kernel feature — process isolation, copy-on-write fork, mmap, swapping — is some clever manipulation of these tables.

---

## 9. Timer and preemption

The PIT (Programmable Interval Timer) at I/O ports `0x40`–`0x43` can be programmed to fire at a chosen frequency, e.g., 100 Hz. Each tick raises IRQ 0 (vector 32 after remap), and your handler runs.

```c
void timer_tick(void) {
    static uint64_t ticks = 0;
    ticks++;
    schedule();    // pick the next thread to run
}
```

`schedule()` is, in its simplest form:

```c
void schedule(void) {
    Task *next = pick_next_task();
    if (next == current_task) return;
    context_switch(&current_task->regs, &next->regs);  // assembly: save / load
    current_task = next;
}
```

`context_switch` is ~30 lines of assembly — save the callee-saved registers, load the new set, return. Stacks switch automatically because `rsp` is one of the registers you swap.

The moment two cooperating tasks alternate in your kernel — printing "A" and "B" interleaved on the VGA buffer — is the second mind-changing moment of the project. You wrote the scheduler. There is no magic.

---

## 10. Common pitfalls

1. **Forgetting `volatile` on MMIO**. The compiler will optimize away your loads/stores to the VGA buffer. `volatile uint16_t*` is the spell.
2. **No stack alignment**. `call` pushes a return address; the SysV ABI requires `rsp` to be 16-aligned at the *call*, so your assembly entry has to align before calling C.
3. **Re-enabling interrupts inside a handler too early**. You'll re-enter the same handler before it returns. Usually you `cli` on entry and let `iretq` restore.
4. **Page tables in unmapped memory**. Classic chicken-and-egg. Either identity-map them or use boot-time page tables you carefully placed.
5. **No serial output**. When the VGA breaks, you can't see what's wrong. Add serial port output (4 lines of code) immediately; debug through `qemu-system-x86_64 -serial stdio`.
6. **Trusting C's runtime**. There is no runtime. No `printf` until you write it. No `memcpy` until you implement it. No global constructors. No `errno`. Set the compiler flags (`-ffreestanding -nostdlib -fno-stack-protector -fno-builtin`).
7. **Using floating-point in the kernel**. The CPU's FPU/SSE state isn't saved on interrupt by default. Either save it manually or compile the kernel with `-mno-sse -mno-mmx`.
8. **Spending months on the bootloader instead of the kernel**. Use GRUB. Come back to writing a bootloader after you have a kernel that does something.

---

## 11. Variations you'll encounter in the wild

- **xv6** (MIT) — pedagogical Unix-like kernel. ~10k lines of clean C and assembly. *The* textbook kernel; if you read one OS source, read this.
- **Linux** — ~30M LOC. Don't read the whole thing; do read `kernel/sched/core.c`, `kernel/fork.c`, `arch/x86/kernel/head_64.S`.
- **seL4** — formally verified microkernel. ~10k LOC of C, plus a proof script.
- **Redox** — Rust microkernel. Modern design, fascinating to read.
- **FreeBSD** — BSD lineage, traditional Unix kernel. Cleaner code than Linux in many places.
- **Plan 9** — Bell Labs' "what if Unix were better." 9P, namespaces, everything-is-a-file taken seriously.
- **Genode** — component-based OS. Microkernel + carefully designed user-space.
- **Hobbyist kernels**: SerenityOS (huge community), ToaruOS (one person, very polished), Theseus (Rust, single-address-space).

---

## 12. Where this shows up in the real world

- Every operating system you use: Linux, macOS (Darwin/XNU), Windows NT kernel, iOS, Android.
- Every game console runtime, every embedded RTOS (FreeRTOS, Zephyr, VxWorks).
- Hypervisors (KVM, Xen, ESXi) — same architecture, one more ring.
- Unikernels (MirageOS, IncludeOS) — your application *is* the kernel.
- Browser sandboxes — same mechanisms (page tables, syscall filtering, IPC) but in user space.

---

## 13. Going deeper

1. **Write a keyboard driver.** Read scancodes from port `0x60`; translate to ASCII; feed an in-kernel REPL.
2. **Write a tiny shell** inside the kernel. Now you have an interactive system.
3. **Add user mode.** Set up a TSS; load a binary at a low address with user-page mappings; `iretq` into ring 3. Now you have privilege separation.
4. **Implement syscalls.** `syscall` instruction on x86_64; argument convention; trap into kernel; dispatch; return.
5. **Add a filesystem.** FAT12 is ~300 lines and pre-dates everything else. Then ext2 (~1000 lines for read-only).
6. **Add an ELF loader.** Now your shell can `exec` external programs.
7. **Write a real bootloader.** Real-mode-to-protected-mode transition, A20 line, BIOS disk reads. A whole separate project; many tutorials available.
8. **Read xv6 source end to end.** ~10k lines. The clearest kernel code in existence.
9. **Do MIT 6.S081.** Free online; uses xv6; writes kernel features as homework. Easily the best OS course material publicly available.

---

## 14. Industry context

> Writing your own kernel is a rite of passage that most working programmers never undertake. The few who do tend to write better systems code forever after, because they have *seen the floor* — they know there's no further turtle.

- **Active debate**: Monolithic (Linux, Windows) vs. microkernel (seL4, QNX, Redox) vs. unikernel (MirageOS, IncludeOS) vs. exokernel (research). Every decade reopens it; every decade the monolithic camp wins in production for performance reasons; every decade the alternatives gain ground in security-critical niches.
- **Historical context**: Andrew Tanenbaum wrote MINIX in 1987 as a teaching OS. Linus saw it, wrote Linux (1991) — and his choice to go monolithic instead of microkernel started the [Tanenbaum-Torvalds debate](https://en.wikipedia.org/wiki/Tanenbaum%E2%80%93Torvalds_debate), which is still cited today.
- **What a tech lead would ask**: "What's your interrupt latency?" (Time from IRQ raised to handler running; for soft real-time, microseconds matter.) "How do you handle multi-core?" (Per-CPU data structures, fine-grained locking, RCU.) "What's your boot time?" (For embedded, this is a top-line metric.) "How do you handle untrusted user code?" (Page tables + privilege rings + syscall filtering.)
- **Forward-looking**: Rust in the kernel (Linux is slowly absorbing Rust drivers). Confidential computing (kernel runs inside an enclave). Unikernels for serverless. Capability-based OSes (Fuchsia).
- **Names worth knowing**: Linus Torvalds, Andrew Tanenbaum, Dave Cutler (NT kernel architect), Jochen Liedtke (L4 microkernel), Brian Kantor & Dennis Ritchie (Unix lineage), Wei Liu / Andy Lutomirski / Greg Kroah-Hartman (current Linux core), Lina (Asahi Linux GPU driver).

---

## 15. Self-check questions

1. What is the kernel's *first* instruction after boot, and what state is the CPU in when it runs?
2. What is in the GDT, and why do you need it even in long mode?
3. What is the IDT, and what does the CPU do when an interrupt fires?
4. What's the page-table structure on x86_64, and what does the CPU do on every memory access?
5. What's the difference between a page fault and a segmentation fault?
6. What does the timer interrupt enable for the scheduler?
7. What does a syscall actually do at the instruction level?
8. Why is `volatile` necessary for MMIO?
9. Why do you need a cross-compiler instead of your host's GCC?
10. What does "ring 0 vs. ring 3" mean in practice?

If you can answer these, you have seen the floor of your computing stack. Most programmers go their whole career without that view; you will write better code for it forever.
