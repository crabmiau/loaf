import React from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";

const SPINNER_TYPES = [
  "dots",
  "dots2",
  "dots3",
  "dots4",
  "dots5",
  "dots6",
  "dots7",
  "dots8",
  "dots9",
  "dots10",
  "dots11",
  "dots12",
  "dots13",
  "dots8Bit",
  "sand",
  "line",
  "line2",
  "pipe",
  "simpleDots",
  "simpleDotsScrolling",
  "star",
  "star2",
  "flip",
  "hamburger",
  "growVertical",
  "growHorizontal",
  "balloon",
  "balloon2",
  "noise",
  "bounce",
  "boxBounce",
  "boxBounce2",
  "triangle",
  "binary",
  "arc",
  "circle",
  "squareCorners",
  "circleQuarters",
  "circleHalves",
  "squish",
  "toggle",
  "toggle2",
  "toggle3",
  "toggle4",
  "toggle5",
  "toggle6",
  "toggle7",
  "toggle8",
  "toggle9",
  "toggle10",
  "toggle11",
  "toggle12",
  "toggle13",
  "arrow",
  "arrow2",
  "arrow3",
  "bouncingBar",
  "bouncingBall",
  "smiley",
  "monkey",
  "hearts",
  "clock",
  "earth",
  "material",
  "moon",
  "runner",
  "pong",
  "shark",
  "dqpb",
  "weather",
  "christmas",
  "grenade",
  "point",
  "layer",
  "betaWave",
  "fingerDance",
  "fistBump",
  "soccerHeader",
  "mindblown",
  "speaker",
  "orangePulse",
  "bluePulse",
  "orangeBluePulse",
  "timeTravel",
  "aesthetic",
  "dwarfFortress",
] as const;

function App() {
  const { exit } = useApp();

  useInput((character, key) => {
    if ((key.ctrl && character === "c") || character === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyanBright">spinner gallery (press q to exit)</Text>
      {SPINNER_TYPES.map((type) => (
        <Box key={type}>
          <Text color="yellow">
            <Spinner type={type as any} />{" "}
          </Text>
          <Text color="white">{type}</Text>
        </Box>
      ))}
    </Box>
  );
}

render(<App />);
