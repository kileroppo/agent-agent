import "./index.css";
import { MyComposition } from "./Composition";
import { M5ContentCompositions } from "./M5ContentComposition";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
      <M5ContentCompositions />
    </>
  );
};
