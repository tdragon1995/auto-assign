// /ndtp — BV Nhi Đồng Thành Phố sends samples to a fixed set of partner sites.
// Shared by the page (dropdown) and the API (whitelist: the client never picks a
// customer_id the server has not listed).

export const NDTP_PICKUP = {
  customer_id: "34fb2846-6719-11ee-a2cd-506b8d9879b5",
  name: "46647681 - BChanh - VTChi - BỆNH VIỆN NHI ĐỒNG THÀNH PHỐ",
};

export const NDTP_DROPOFFS: { customer_id: string; name: string }[] = [
  { customer_id: "368ecfe6-77cc-11ee-a9f0-506b8d9879b5", name: "NDTP - BChanh - DK3 - BV Truyền Máu Huyết Học" },
  { customer_id: "6d37ecaa-89a4-11ee-8bc4-506b8d9879b5", name: "NDTP - BChanh - TTuc - TTYT Huyện Bình Chánh" },
  { customer_id: "85f2a1c6-77d0-11ee-98da-506b8d9879b5", name: "NDTP - BChanh - YT3 - Trung Tâm Pháp Y" },
  { customer_id: "4b3fd89c-77ca-11ee-99a3-506b8d9879b5", name: "NDTP - D10 - HHao - MEDIC" },
  { customer_id: "e62f29e0-77cd-11ee-8493-506b8d9879b5", name: "NDTP - D10 - SVHanh - BV Nhi Đồng 1" },
  { customer_id: "b6c49e9a-7df1-11ee-9baf-506b8d9879b5", name: "NDTP - D1 - CBac - Viện Kiểm Thuốc" },
  { customer_id: "b6e7e99c-77cd-11ee-86b3-506b8d9879b5", name: "NDTP - D1 - CQuynh - BV Từ Dũ" },
  { customer_id: "1516c6e4-77d0-11ee-b143-506b8d9879b5", name: "NDTP - D1 - LTTrong - BV Nhi Đồng 2" },
  { customer_id: "b740f16c-77ce-11ee-a06f-506b8d9879b5", name: "NDTP - D3 - NThong - BV Da Liễu" },
  { customer_id: "998f85d4-77ce-11ee-a6fe-506b8d9879b5", name: "NDTP - D3 - Pasteur - Viện Pasteur" },
  { customer_id: "95050202-dc30-11ee-914e-506b8d9879b5", name: "NDTP - D3 - TDinh - Bionet" },
  { customer_id: "cf8973be-77cb-11ee-bfd6-506b8d9879b5", name: "NDTP - D5 - HBang - BV Đại Học Y Dược" },
  { customer_id: "4a6d8864-77d0-11ee-92e0-506b8d9879b5", name: "NDTP - D5 - LTKiet - Bv Hùng Vương" },
  { customer_id: "46c779fc-77cd-11ee-9b88-506b8d9879b5", name: "NDTP - D5 - NCThanh - BV Chợ Rẫy" },
  { customer_id: "e508f34c-77ce-11ee-b62b-506b8d9879b5", name: "NDTP - D5 - NQuyen - BV Phạm Ngọc Thạch" },
  { customer_id: "2ea2d51c-77cb-11ee-b9fb-506b8d9879b5", name: "NDTP - D5 - PDTVuong - BV Đại Học Y Dược" },
  { customer_id: "bdc0c6b4-77d0-11ee-84e1-506b8d9879b5", name: "NDTP - D5 - THDao - HCDC" },
  { customer_id: "feea7a18-77cb-11ee-be1e-506b8d9879b5", name: "NDTP - D5 - VVKiet - BV Nhiệt Đới" },
  { customer_id: "704c946a-77cd-11ee-a264-506b8d9879b5", name: "NDTP - D7 - TXSoan - Nam Khoa Biotek" },
  { customer_id: "5bd4514e-fc70-11ee-9d6d-506b8d9879b5", name: "NDTP - D8 - HPhu - Viện Y Tế Công Cộng" },
];
