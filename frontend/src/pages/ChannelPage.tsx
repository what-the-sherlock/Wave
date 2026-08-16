import { useParams, useSearchParams } from "react-router-dom";
import WorkspaceSidebar from "../components/WorkspaceSidebar";
import ChatContainer from "../components/ChatContainer";

const ChannelPage = () => {
  const { channelId } = useParams<{ channelId: string }>();
  const [searchParams] = useSearchParams();
  if (!channelId) return null;

  const seqParam = searchParams.get("seq");
  const initialSeq = seqParam ? Number(seqParam) : undefined;

  return (
    <div className="flex mt-16 h-[calc(100vh-4rem)]">
      <WorkspaceSidebar />
      <ChatContainer channelId={channelId} initialSeq={initialSeq} />
    </div>
  );
};

export default ChannelPage;
