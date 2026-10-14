// The coaching library the coach retrieves from.
//
// Hand-written, short, and deliberately plain: each cue is something a dance
// teacher would say out loud in a studio. `joints` is the joint family it
// fixes, `problems` the direction of the error (see readJoint in coach.js).
// Add cues here; nothing else needs to change.

export const CUES = [
  // ---- elbows ----
  { id: 'elbow-bend-1', joints: ['elbow'], problems: ['too_straight'],
    cue: 'Soften the elbow — bend it like you are holding a cup, not pointing.',
    why: 'Locked arms read stiff and miss the shape of the move.' },
  { id: 'elbow-bend-2', joints: ['elbow'], problems: ['too_straight'],
    cue: 'Pull the hand back toward your shoulder before you push it out again.',
    why: 'Most choreography passes through a bent arm on the way to a straight one.' },
  { id: 'elbow-extend-1', joints: ['elbow'], problems: ['too_bent'],
    cue: 'Reach all the way through your fingertips — finish the line.',
    why: 'Stopping short of full extension is the most common way arm hits look small.' },
  { id: 'elbow-extend-2', joints: ['elbow'], problems: ['too_bent'],
    cue: 'Imagine touching a wall an arm\'s length away.',
    why: 'An external target gets the arm fully long without thinking about the joint.' },

  // ---- shoulders (how high the arm is) ----
  { id: 'arm-raise-1', joints: ['shoulder'], problems: ['too_low'],
    cue: 'Bring the elbow up to shoulder height, not chest height.',
    why: 'Arms drop as you tire; height is what makes the shape visible.' },
  { id: 'arm-raise-2', joints: ['shoulder'], problems: ['too_low'],
    cue: 'Lift from the back of the shoulder, keep the neck long.',
    why: 'Lifting from the back keeps the shoulder from hunching up toward the ear.' },
  { id: 'arm-lower-1', joints: ['shoulder'], problems: ['too_high'],
    cue: 'Keep the arm at chest level — it is lower than you think.',
    why: 'Over-raising is common when copying from a screen above eye level.' },
  { id: 'arm-lower-2', joints: ['shoulder'], problems: ['too_high'],
    cue: 'Drop the shoulders down and away from your ears first.',
    why: 'Raised shoulders lift the whole arm with them.' },

  // ---- hips ----
  { id: 'hip-fold-1', joints: ['hip'], problems: ['too_straight'],
    cue: 'Hinge at the hips and get lower — sit back like there is a chair behind you.',
    why: 'Grounded styles live in a folded hip; standing tall loses the groove.' },
  { id: 'hip-fold-2', joints: ['hip'], problems: ['too_straight'],
    cue: 'Lean the chest forward over your toes on that count.',
    why: 'A forward lean is part of the shape, not a mistake.' },
  { id: 'hip-open-1', joints: ['hip'], problems: ['too_bent'],
    cue: 'Stand up taller through the chest — push the hips forward.',
    why: 'Folding too far makes the move look tired and hides the arms.' },

  // ---- knees ----
  { id: 'knee-bend-1', joints: ['knee'], problems: ['too_straight'],
    cue: 'Bend the knees and stay bouncy — never lock them.',
    why: 'Straight legs kill rhythm; the bounce is where the beat lives.' },
  { id: 'knee-bend-2', joints: ['knee'], problems: ['too_straight'],
    cue: 'Drop your level by a hand\'s width for this step.',
    why: 'Level changes are easy to miss on video but obvious in the stickman.' },
  { id: 'knee-extend-1', joints: ['knee'], problems: ['too_bent'],
    cue: 'Straighten the standing leg — push the floor away.',
    why: 'Staying crouched blurs the difference between the high and low counts.' },
  { id: 'knee-extend-2', joints: ['knee'], problems: ['too_bent'],
    cue: 'Kick through to a long leg, then bring it back.',
    why: 'A full extension makes kicks and steps read clearly.' },

  // ---- general ----
  { id: 'any-slow', joints: ['any'], problems: ['too_straight', 'too_bent', 'too_high', 'too_low'],
    cue: 'Do it at half speed in the mirror until the shape is right, then speed up.',
    why: 'Speed hides shape mistakes; slow practice fixes them.' },
];
