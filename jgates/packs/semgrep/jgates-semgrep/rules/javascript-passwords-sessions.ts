import { IsString, MinLength, MaxLength } from "class-validator";

class ShortDto {
  @IsString()
  // ruleid: jgates.js.password-min-length-below-8
  @MinLength(6)
  password!: string;
}

class CappedDto {
  @IsString()
  // ruleid: jgates.js.password-max-length-below-64
  @MaxLength(20)
  password!: string;
}

class GoodDto {
  @IsString()
  // ok: jgates.js.password-min-length-below-8
  @MinLength(12)
  // ok: jgates.js.password-max-length-below-64
  @MaxLength(128)
  password!: string;

  @IsString()
  // ok: jgates.js.password-min-length-below-8
  @MinLength(3)
  username!: string;
}

function checkTyped(password: string): void {
  // ruleid: jgates.js.password-min-length-below-8
  if (password.length < 7) throw new Error("short");
  // ok: jgates.js.password-min-length-below-8
  if (password.length < 8) throw new Error("short");
}
