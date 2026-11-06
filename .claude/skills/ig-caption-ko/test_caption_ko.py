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

    def test_existing_engagement_request(self):
        self.assertEqual(analyse('다음에 볼 수 있게 저장해 두세요.')['asks'], ['저장'])


if __name__ == '__main__':
    unittest.main()
