import Frame from "../../components/frame";

export default function Post({ id }: { id: string }) {
  return <Frame title="Post">Post {id}</Frame>;
}
