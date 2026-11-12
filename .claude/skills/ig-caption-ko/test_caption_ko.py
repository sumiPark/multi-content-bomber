import unittest
from caption_ko import analyse


class CaptionRequestsTest(unittest.TestCase):
    def test_real_product_guide_request(self):
        result = analyse('파이니티 버블토너 사용 순서: 1단계\n\n사용 전 제품 안내를 꼭 확인해 주세요!\n\n#버블토너 #스킨케어 #사용순서')
        self.assertEqual(result['asks'], ['정보 확인'])

    def test_plain_statement_is_not_a_request(self):
        self.assertEqual(analyse('제품 안내에서 사용 순서를 확인할 수 있어요.')['asks'], [])

    def test_two_requests_remain_two(self):
        self.assertEqual(len(analyse('저장해 두세요. 제품 안내도 확인하세요.')['asks']), 2)

    def test_emoji_comment_keyword(self):
        for text in ('댓글에 ❤️ 남겨주세요', '댓글에 ❤ 남겨 주시면 링크 보내드릴게요', '댓글로 🍐를 달아 주세요', '댓글에 "🙌" 남겨 주세요'):
            self.assertEqual(analyse(text)['asks'], ['댓글 키워드'], text)

    def test_word_comment_keyword_still_works(self):
        self.assertEqual(analyse('댓글에 하트 남겨 주세요')['asks'], ['댓글 키워드'])

    def test_emoji_alone_is_not_a_request(self):
        self.assertEqual(analyse('오늘도 맛있게 먹었어요 ❤️')['asks'], [])

    def test_existing_engagement_request(self):
        self.assertEqual(analyse('다음에 볼 수 있게 저장해 두세요.')['asks'], ['저장'])


if __name__ == '__main__':
    unittest.main()
