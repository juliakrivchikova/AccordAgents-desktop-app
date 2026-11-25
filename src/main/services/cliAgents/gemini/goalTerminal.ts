import { ANTIGRAVITY_EXECUTABLE_ENV } from "./constants";

export const ANTIGRAVITY_GOAL_ENV = "ACCORD_AGENTS_NATIVE_GOAL_PROMPT";
export const ANTIGRAVITY_GOAL_ARG_COUNT_ENV = "ACCORD_AGENTS_NATIVE_GOAL_ARG_COUNT";
export const ANTIGRAVITY_GOAL_ARG_ENV_PREFIX = "ACCORD_AGENTS_NATIVE_GOAL_ARG_";
export const ANTIGRAVITY_EXPECT_PATH = "/usr/bin/expect";
export const ANTIGRAVITY_GOAL_CANCEL_GRACE_MS = 2_500;

export function antigravityExpectProgram(): string {
  return `
  set timeout -1
  set goal $env(${ANTIGRAVITY_GOAL_ENV})
  set args {}
  for {set i 0} {$i < $env(${ANTIGRAVITY_GOAL_ARG_COUNT_ENV})} {incr i} {
    set key "${ANTIGRAVITY_GOAL_ARG_ENV_PREFIX}$i"
    lappend args $env($key)
  }
  set stty_init "rows 40 columns 120"
  spawn -noecho $env(${ANTIGRAVITY_EXECUTABLE_ENV}) {*}$args -i $goal
  set child $spawn_id
  log_user 0
  fconfigure stdin -translation binary -encoding binary -blocking 0
  fconfigure stdout -translation binary -encoding binary -buffering none
  proc forward_input {} {
    global child
    set data [read stdin 4096]
    if {[string length $data] > 0} {
      send -i $child -raw -- $data
    }
  }
  fileevent stdin readable forward_input
  expect {
    -i $child -re {(.|\\r|\\n)+} {
      puts -nonewline stdout $expect_out(buffer)
      exp_continue
    }
    -i $child eof {}
  }
  set result [wait -i $child]
  exit [lindex $result 3]
`;
}

export const ANTIGRAVITY_EXPECT_PROGRAM = antigravityExpectProgram();

export function antigravityInteractiveGoalAtPrompt(transcript: string): boolean {
  const generating = transcript.lastIndexOf("Generating");
  return generating >= 0 && transcript.lastIndexOf("? for shortcuts") > generating;
}

export function antigravityInteractivePermissionPrompt(transcript: string): boolean {
  return transcript.includes("Requesting permission for:") && transcript.includes("Do you want to proceed?");
}
