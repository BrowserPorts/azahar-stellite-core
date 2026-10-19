// SPDX-License-Identifier: GPL-2.0-or-later

export interface InputState {
  buttons: number;
  circleX: number;
  circleY: number;
  cstickX: number;
  cstickY: number;
  touchX: number;
  touchY: number;
  touchPressed: boolean;
}

export function checkInputState(value: InputState): undefined {
  if (!value || typeof value !== "object" ||
    !Number.isInteger(value.buttons) || value.buttons < 0 || value.buttons > 0xffff ||
    ![value.circleX, value.circleY, value.cstickX, value.cstickY, value.touchX, value.touchY]
      .every(axis => Number.isInteger(axis) && axis >= -32768 && axis <= 32767) ||
    typeof value.touchPressed !== "boolean") throw new Error("Invalid input state");
  return undefined;
}
