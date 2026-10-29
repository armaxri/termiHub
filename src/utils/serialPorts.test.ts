import { describe, it, expect } from "vitest";
import { compareSerialPorts, sortSerialPorts } from "./serialPorts";

describe("sortSerialPorts (#5066)", () => {
  it("orders Windows COM ports numerically", () => {
    // The order the maintainer saw in the dropdown.
    const raw = ["COM7", "COM27", "COM29", "COM28", "COM30", "COM9", "COM10", "COM11", "COM3"];
    expect(sortSerialPorts(raw)).toEqual([
      "COM3",
      "COM7",
      "COM9",
      "COM10",
      "COM11",
      "COM27",
      "COM28",
      "COM29",
      "COM30",
    ]);
  });

  it("orders Linux device paths numerically", () => {
    expect(
      sortSerialPorts(["/dev/ttyUSB10", "/dev/ttyS0", "/dev/ttyUSB2", "/dev/ttyACM0"])
    ).toEqual(["/dev/ttyACM0", "/dev/ttyS0", "/dev/ttyUSB2", "/dev/ttyUSB10"]);
  });

  it("groups macOS cu.* before tty.* and orders suffix numbers naturally", () => {
    expect(
      sortSerialPorts([
        "/dev/tty.usbserial-110",
        "/dev/cu.usbserial-110",
        "/dev/tty.usbserial-2",
        "/dev/cu.usbserial-2",
      ])
    ).toEqual([
      "/dev/cu.usbserial-2",
      "/dev/cu.usbserial-110",
      "/dev/tty.usbserial-2",
      "/dev/tty.usbserial-110",
    ]);
  });

  it("drops duplicates and does not mutate its input", () => {
    const raw = ["COM10", "COM2", "COM10"];
    expect(sortSerialPorts(raw)).toEqual(["COM2", "COM10"]);
    expect(raw).toEqual(["COM10", "COM2", "COM10"]);
  });

  it("compareSerialPorts is a usable Array.sort comparator", () => {
    expect(compareSerialPorts("COM3", "COM10")).toBeLessThan(0);
    expect(compareSerialPorts("COM10", "COM3")).toBeGreaterThan(0);
    expect(compareSerialPorts("COM3", "COM3")).toBe(0);
  });
});
