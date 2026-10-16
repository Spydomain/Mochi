/* Regression coverage for iPhone AWDL action frames with a short trailer. */
extern "C" {
#include "rx.h"
#include "peers.h"
#include "wire.h"
}

#include <cstring>
#include <vector>

#include "gtest/gtest.h"

class ActionRx : public ::testing::Test {
protected:
	struct awdl_state state;
	const struct ether_addr self = {{0x02, 0, 0, 0, 0, 1}};
	const struct ether_addr phone = {{0x02, 0, 0, 0, 0, 2}};

	void SetUp() override {
		awdl_init_state(&state, "test", &self, CHAN_OPCLASS_149, 0);
		state.filter_rssi = 0;
	}

	void TearDown() override {
		awdl_peers_free(state.peers.peers);
	}

	int receive_mif(int trailer_len) {
		std::vector<uint8_t> bytes(sizeof(struct awdl_action) + 5 + trailer_len, 0);
		struct awdl_action hdr = {};
		hdr.category = IEEE80211_VENDOR_SPECIFIC;
		hdr.oui.byte[0] = 0x00;
		hdr.oui.byte[1] = 0x17;
		hdr.oui.byte[2] = 0xf2;
		hdr.type = AWDL_TYPE;
		hdr.version = AWDL_VERSION_COMPAT;
		hdr.subtype = AWDL_ACTION_MIF;
		std::memcpy(bytes.data(), &hdr, sizeof(hdr));
		const size_t offset = sizeof(hdr);
		bytes[offset] = AWDL_VERSION_TLV;
		bytes[offset + 1] = 2;
		bytes[offset + 2] = 0;
		bytes[offset + 3] = awdl_version(3, 4);
		bytes[offset + 4] = AWDL_DEVCLASS_IOS;
		for (int i = 0; i < trailer_len; ++i)
			bytes[offset + 5 + i] = static_cast<uint8_t>(0x71 + i);
		const struct buf *frame = buf_new_const(bytes.data(), bytes.size());
		int result = awdl_rx_action(frame, -40, 100, &phone, &self, &state);
		buf_free(frame);
		return result;
	}

	struct awdl_peer *peer() {
		struct awdl_peer *found = nullptr;
		EXPECT_EQ(awdl_peer_get(state.peers.peers, &phone, &found), PEERS_OK);
		return found;
	}
};

TEST_F(ActionRx, accepts_mif_with_two_trailing_bytes_and_validates_peer) {
	EXPECT_EQ(receive_mif(2), RX_OK);
	ASSERT_NE(peer(), nullptr);
	EXPECT_EQ(peer()->sent_mif, 1);
	EXPECT_EQ(peer()->is_valid, 1);
}

TEST_F(ActionRx, rejects_other_incomplete_trailers) {
	EXPECT_EQ(receive_mif(1), RX_UNEXPECTED_FORMAT);
	EXPECT_EQ(peer()->sent_mif, 0);
	EXPECT_EQ(receive_mif(3), RX_UNEXPECTED_FORMAT);
	EXPECT_EQ(peer()->sent_mif, 0);
}

TEST_F(ActionRx, accepts_mif_without_trailer) {
	EXPECT_EQ(receive_mif(0), RX_OK);
	EXPECT_EQ(peer()->is_valid, 1);
}
